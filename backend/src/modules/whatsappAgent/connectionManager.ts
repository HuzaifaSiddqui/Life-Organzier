import { Prisma, type WhatsAppAgentConnection } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { sendPushToUser } from "../push/pushService.js";
import { AgentError, ConflictError, createAgentClient, ForbiddenError, InvalidKeyError, RateLimitedError, type WhatsAppAgentClient } from "./client.js";
import { POLL_LIMIT, POLL_TIMEOUT_S } from "./config.js";
import type { AgentLock } from "./lock.js";
import { Outbox, PRIORITY, type Priority, type SendOutcome } from "./outbox.js";
import { ConnectionLimiter, realClock, type Clock } from "./rateLimiter.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import type { AgentUpdate, UpdateBatch } from "./shapes.js";

/**
 * Keeps one long-poll loop per CONNECTED WhatsApp Agent connection (docs/whatsapp-agent.md):
 * - exactly one poller per key: an advisory lock (lock.ts) across instances, a map within this one;
 * - long poll (25 s) with exponential backoff and full jitter on network errors;
 * - 401 / 400 code 100 → NEEDS_RECONNECT, polling stops, the user gets a push; 409 → wait, re-check the lock;
 *   429 → the poll bucket is blocked until the API's budget is back;
 * - each message is claimed in WhatsAppProcessedUpdate (by message id) before it is handled, so a retry or restart
 *   never acts twice; the API's next_offset is saved only after the whole batch was handled. An update claimed but never finished (crash)
 *   gets one "please resend" when the poller starts again.
 */

export const MISSED_REPLY = "Sorry, I missed your last message. Please send it again.";
export const ERROR_REPLY = "Sorry, something went wrong. Please try again.";
const CONFLICT_WAIT_MS = 30000;
const MAX_BACKOFF_MS = 60000;

export type HandlerIO = {
  reply(text: string, priority?: Priority): Promise<SendOutcome>;
  client: WhatsAppAgentClient;
  limiter: ConnectionLimiter;
};
export type UpdateHandler = (connection: WhatsAppAgentConnection, update: AgentUpdate, io: HandlerIO) => Promise<void>;

export type ManagerDeps = {
  lock: AgentLock;
  handler: UpdateHandler;
  clock?: Clock;
  random?: () => number;
  pollTimeoutS?: number;
  rescanMs?: number;
};

/** Delay before retry `n` (1-based): full jitter over 1 s · 2^n, capped at a minute, never under 0.5 s. */
export function backoffMs(n: number, random: () => number = Math.random): number {
  const cap = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** n);
  return Math.max(500, Math.floor(random() * cap));
}

async function claim(connectionId: string, updateId: string): Promise<boolean> {
  try {
    await prisma.whatsAppProcessedUpdate.create({ data: { connectionId, updateId } });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
    throw error;
  }
}

/** Never logs message text or secrets: the error's class and message only (client errors hold no key). */
function logSafe(what: string, error: unknown): void {
  console.warn(`WhatsApp Agent: ${what}:`, error instanceof AgentError ? `${error.constructor.name} ${error.message}` : error instanceof Error ? error.name : "error");
}

class Poller {
  readonly abort = new AbortController();
  readonly limiter: ConnectionLimiter;
  readonly client: WhatsAppAgentClient;
  readonly outbox: Outbox;
  private chatRef: string | null;
  private offset: string | null;
  done: Promise<void> = Promise.resolve();

  constructor(
    private connection: WhatsAppAgentConnection,
    private readonly manager: AgentConnectionManager,
  ) {
    this.limiter = new ConnectionLimiter(manager.clock);
    this.client = createAgentClient(decryptSecret(connection.encryptedKey, connection.userId));
    this.chatRef = connection.chatRef ? decryptSecret(connection.chatRef, connection.userId) : null;
    this.offset = connection.lastOffset;
    this.outbox = new Outbox(
      async (text) => {
        await this.client.sendText(text, this.chatRef);
      },
      this.limiter,
      (error) => void this.fatal(error),
    );
  }

  get id(): string {
    return this.connection.id;
  }

  start(): void {
    this.done = this.run().catch((error) => logSafe("poller stopped", error));
  }

  stop(): void {
    this.abort.abort();
    this.outbox.close();
  }

  private async fatal(error: AgentError): Promise<void> {
    if (this.abort.signal.aborted) return;
    this.stop();
    await this.manager.markBroken(this.connection, error);
  }

  private io(): HandlerIO {
    return { reply: (text, priority = PRIORITY.reply) => this.outbox.enqueue(text, priority), client: this.client, limiter: this.limiter };
  }

  /** Updates claimed by an earlier run that never finished: one "please resend" for all of them. */
  private async recoverLost(): Promise<void> {
    const lost = await prisma.whatsAppProcessedUpdate.findMany({ where: { connectionId: this.id, processedAt: null }, select: { id: true } });
    if (!lost.length) return;
    await prisma.whatsAppProcessedUpdate.updateMany({ where: { id: { in: lost.map((l) => l.id) } }, data: { processedAt: new Date(this.manager.clock.now()) } });
    void this.outbox.enqueue(MISSED_REPLY);
  }

  private async run(): Promise<void> {
    const { signal } = this.abort;
    const { clock, lock } = this.manager;
    await this.recoverLost();
    let failures = 0;
    while (!signal.aborted) {
      if (!(await lock.held(this.id)) && !(await lock.tryAcquire(this.id))) {
        console.warn("WhatsApp Agent: another instance holds this connection; this poller stops");
        break;
      }
      if (!(await this.limiter.acquire("polls", signal))) break;
      let batch: UpdateBatch;
      try {
        batch = await this.client.getUpdates({ offset: this.offset, limit: POLL_LIMIT, timeoutS: this.manager.pollTimeoutS, signal });
        failures = 0;
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof InvalidKeyError || error instanceof ForbiddenError) {
          await this.fatal(error);
          break;
        }
        if (error instanceof ConflictError) {
          logSafe("poll conflict", error);
          await clock.sleep(CONFLICT_WAIT_MS + Math.floor(this.manager.random() * 5000), signal);
          continue; // the lock is checked again at the top
        }
        if (error instanceof RateLimitedError) {
          this.limiter.block("polls", error.retryAfterMs);
          await prisma.whatsAppAgentConnection.update({ where: { id: this.id }, data: { rateLimitedUntil: new Date(clock.now() + this.limiter.blockedFor("polls")) } }).catch(() => undefined);
          continue;
        }
        failures += 1;
        logSafe("poll failed", error);
        await clock.sleep(backoffMs(failures, this.manager.random), signal);
        continue;
      }
      await prisma.whatsAppAgentConnection.update({ where: { id: this.id }, data: { lastPollAt: new Date(clock.now()), rateLimitedUntil: null } }).catch(() => undefined);
      let complete = true;
      for (const update of batch.updates) {
        if (signal.aborted) {
          complete = false;
          break;
        }
        await this.process(update);
      }
      // Only after the batch: a crash before this re-delivers it, and the claims skip what was already done.
      if (complete && batch.nextOffset && batch.nextOffset !== this.offset) {
        this.offset = batch.nextOffset;
        await prisma.whatsAppAgentConnection.update({ where: { id: this.id }, data: { lastOffset: this.offset } });
      }
    }
    await lock.release(this.id).catch(() => undefined);
  }

  private async process(update: AgentUpdate): Promise<void> {
    if (await claim(this.id, update.id)) {
      if (update.chatRef && update.chatRef !== this.chatRef) {
        this.chatRef = update.chatRef;
        await prisma.whatsAppAgentConnection.update({ where: { id: this.id }, data: { chatRef: encryptSecret(update.chatRef, this.connection.userId) } });
      }
      try {
        await this.manager.handler(this.connection, update, this.io());
      } catch (error) {
        logSafe("message failed", error);
        void this.outbox.enqueue(ERROR_REPLY);
      }
      await prisma.whatsAppProcessedUpdate.updateMany({ where: { connectionId: this.id, updateId: update.id }, data: { processedAt: new Date(this.manager.clock.now()) } });
      // Read receipt: best effort, only if the status budget has room right now.
      if (update.messageId && this.limiter.tryAcquire("statuses")) await this.client.markRead(update.messageId).catch(() => undefined);
    }
  }
}

export class AgentConnectionManager {
  readonly clock: Clock;
  readonly random: () => number;
  readonly pollTimeoutS: number;
  readonly lock: AgentLock;
  readonly handler: UpdateHandler;
  private readonly pollers = new Map<string, Poller>();
  private timer: NodeJS.Timeout | null = null;
  private readonly rescanMs: number;

  constructor(deps: ManagerDeps) {
    this.lock = deps.lock;
    this.handler = deps.handler;
    this.clock = deps.clock ?? realClock;
    this.random = deps.random ?? Math.random;
    this.pollTimeoutS = deps.pollTimeoutS ?? POLL_TIMEOUT_S;
    this.rescanMs = deps.rescanMs ?? 60000;
  }

  /** Loads every CONNECTED connection, then re-scans every minute (takes over keys another instance dropped). */
  async start(): Promise<void> {
    await this.rescan();
    this.timer = setInterval(() => void this.rescan().catch((e) => logSafe("rescan failed", e)), this.rescanMs);
    this.timer.unref();
  }

  async rescan(): Promise<void> {
    // Pro only: a connection whose user went back to Free stops here (and starts again after upgrading).
    const rows = await prisma.whatsAppAgentConnection.findMany({ where: { status: "CONNECTED", user: { settings: { tier: "PRO" } } }, select: { id: true } });
    const live = new Set(rows.map((r) => r.id));
    for (const id of [...this.pollers.keys()]) if (!live.has(id)) await this.remove(id);
    for (const r of rows) await this.add(r.id);
  }

  /** Starts polling this connection here, unless it already runs here or on another instance. */
  async add(connectionId: string): Promise<boolean> {
    if (this.pollers.has(connectionId)) return true;
    const row = await prisma.whatsAppAgentConnection.findUnique({ where: { id: connectionId }, include: { user: { select: { settings: { select: { tier: true } } } } } });
    if (!row || row.status !== "CONNECTED" || row.user.settings?.tier !== "PRO") return false;
    if (!(await this.lock.tryAcquire(connectionId))) return false;
    if (this.pollers.has(connectionId)) return true; // added meanwhile
    let poller: Poller;
    try {
      const { user: _user, ...connection } = row;
      poller = new Poller(connection, this);
    } catch (error) {
      logSafe("could not start", error);
      await this.lock.release(connectionId).catch(() => undefined);
      return false;
    }
    this.pollers.set(connectionId, poller);
    poller.start();
    void poller.done.finally(() => {
      if (this.pollers.get(connectionId) === poller) this.pollers.delete(connectionId);
    });
    return true;
  }

  async remove(connectionId: string): Promise<void> {
    const poller = this.pollers.get(connectionId);
    if (!poller) return;
    poller.stop();
    await poller.done;
    this.pollers.delete(connectionId);
  }

  isPolling(connectionId: string): boolean {
    return this.pollers.has(connectionId);
  }

  /** Sends through this connection's queue and budget; null if this instance doesn't run it. */
  send(connectionId: string, text: string, priority: Priority): Promise<SendOutcome> | null {
    return this.pollers.get(connectionId)?.outbox.enqueue(text, priority) ?? null;
  }

  /** Graceful shutdown: stops every loop (an in-progress poll is aborted), waits, releases the locks. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all([...this.pollers.keys()].map((id) => this.remove(id)));
    await this.lock.close().catch(() => undefined);
  }

  /** The key was rejected (or the user isn't the agent's creator): stop, record why, tell the user. */
  async markBroken(connection: WhatsAppAgentConnection, error: AgentError): Promise<void> {
    const invalid = error instanceof InvalidKeyError;
    await prisma.whatsAppAgentConnection.update({
      where: { id: connection.id },
      data: { status: invalid ? "NEEDS_RECONNECT" : "ERROR", lastError: invalid ? "The API key was rejected. Paste a new key to reconnect." : "WhatsApp refused access to this agent." },
    });
    await sendPushToUser(connection.userId, {
      title: "WhatsApp needs reconnecting",
      body: "Open Settings → WhatsApp and paste your agent's API key again.",
      // "sync": the phone re-plans, so reminders it left to WhatsApp are scheduled as notifications again.
      data: { type: "sync", reason: "whatsapp_agent", status: invalid ? "NEEDS_RECONNECT" : "ERROR" },
    });
  }
}

let current: AgentConnectionManager | null = null;
export function getAgentManager(): AgentConnectionManager | null {
  return current;
}
export function setAgentManager(manager: AgentConnectionManager | null): void {
  current = manager;
}
