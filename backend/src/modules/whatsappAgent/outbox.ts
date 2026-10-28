import { splitMessage } from "../whatsapp/whatsappService.js";
import { AgentError, ForbiddenError, InvalidKeyError, NetworkError, RateLimitedError } from "./client.js";
import { TEXT_LIMIT } from "./config.js";
import type { ConnectionLimiter } from "./rateLimiter.js";

/**
 * Outbound queue for one connection. Replies go before reminders, reminders before digests. Whatever is
 * waiting when the sender is free and has the same priority is coalesced into one message (a burst of
 * reminders becomes one message, not five), then split at 4000 characters. Each part takes a "messages"
 * token. A 429 waits for the API's budget; network errors are retried 3 times with backoff; a rejected key
 * fails everything queued (the caller falls back to push) and is reported once through onFatal.
 */

export const PRIORITY = { reply: 0, reminder: 1, digest: 2 } as const;
export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY];
export type SendOutcome = { ok: true } | { ok: false; error: AgentError };

type Item = { text: string; priority: Priority; seq: number; resolve: (o: SendOutcome) => void };

const MAX_NETWORK_RETRIES = 3;
/** After this many 429s in a row for one message it is reported as failed (reminders then go by push). */
const MAX_RATE_LIMITED_WAITS = 3;

export class Outbox {
  private queue: Item[] = [];
  private seq = 0;
  private running = false;
  private closed = false;

  constructor(
    private readonly send: (text: string) => Promise<void>,
    private readonly limiter: ConnectionLimiter,
    private readonly onFatal: (error: AgentError) => void = () => undefined,
  ) {}

  get size(): number {
    return this.queue.length;
  }

  enqueue(text: string, priority: Priority = PRIORITY.reply): Promise<SendOutcome> {
    if (!text.trim()) return Promise.resolve({ ok: true });
    if (this.closed) return Promise.resolve({ ok: false, error: new AgentError("Disconnected") });
    return new Promise((resolve) => {
      this.queue.push({ text: text.trim(), priority, seq: this.seq++, resolve });
      void this.drain();
    });
  }

  /** Fails everything still queued (disconnect, key rejected). */
  close(error: AgentError = new AgentError("Disconnected")): void {
    this.closed = true;
    this.failAll(error);
  }

  private failAll(error: AgentError): void {
    for (const item of this.queue.splice(0)) item.resolve({ ok: false, error });
  }

  /** The highest-priority item plus everything of the same priority that fits with it in one message. */
  private nextBatch(): Item[] {
    this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    const first = this.queue[0];
    const batch = [first];
    let length = first.text.length;
    for (const item of this.queue.slice(1)) {
      if (item.priority !== first.priority || length + 2 + item.text.length > TEXT_LIMIT) break;
      batch.push(item);
      length += 2 + item.text.length;
    }
    this.queue = this.queue.filter((i) => !batch.includes(i));
    return batch;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Let callers that enqueue in the same tick join the first batch.
      await Promise.resolve();
      while (this.queue.length && !this.closed) {
        const batch = this.nextBatch();
        const outcome = await this.deliver(batch.map((i) => i.text).join("\n\n"));
        for (const item of batch) item.resolve(outcome);
        if (!outcome.ok && (outcome.error instanceof InvalidKeyError || outcome.error instanceof ForbiddenError)) {
          this.failAll(outcome.error);
          this.onFatal(outcome.error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async deliver(text: string): Promise<SendOutcome> {
    for (const part of splitMessage(text, TEXT_LIMIT)) {
      let networkTries = 0;
      let limitedTries = 0;
      for (;;) {
        await this.limiter.acquire("messages");
        try {
          await this.send(part);
          break;
        } catch (error) {
          if (error instanceof RateLimitedError && limitedTries < MAX_RATE_LIMITED_WAITS) {
            limitedTries += 1;
            this.limiter.block("messages", error.retryAfterMs);
            continue;
          }
          if (error instanceof NetworkError && networkTries < MAX_NETWORK_RETRIES) {
            networkTries += 1;
            await this.limiter.clock.sleep(1000 * 2 ** networkTries);
            continue;
          }
          return { ok: false, error: error instanceof AgentError ? error : new AgentError("Send failed") };
        }
      }
    }
    return { ok: true };
  }
}
