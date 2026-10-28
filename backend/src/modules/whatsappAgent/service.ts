import type { WhatsAppAgentConnection } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { HttpError } from "../../lib/http.js";
import { getStt, sttReady } from "../../ai/stt.js";
import { ensureSettings } from "../../lib/http.js";
import { AgentError, ConflictError, createAgentClient, ForbiddenError, InvalidKeyError, NetworkError, RateLimitedError } from "./client.js";
import { agentEnabled, agentRemindersEnabled, agentVoiceEnabled, POLL_LIMIT } from "./config.js";
import { getAgentManager } from "./connectionManager.js";
import { PRIORITY } from "./outbox.js";
import { encryptSecret, last4, secretConfigured } from "./secrets.js";
import { nextOffset } from "./shapes.js";

/** Connect / status / settings / disconnect for the user's WhatsApp Agent. The key is never returned or logged. */

export function requireAgentFeature(): void {
  if (!agentEnabled()) throw new HttpError(404, "FEATURE_OFF", "WhatsApp Agent isn't turned on for this server");
  if (!secretConfigured()) throw new HttpError(503, "NOT_CONFIGURED", "WhatsApp Agent isn't set up on this server yet");
}

async function requirePro(userId: string): Promise<void> {
  if ((await ensureSettings(userId)).tier !== "PRO") throw new HttpError(403, "PRO_REQUIRED", "WhatsApp is part of Pro");
}

/** API errors as replies the app can show. Nothing technical; never the key. */
function asHttp(error: unknown): HttpError {
  if (error instanceof InvalidKeyError) return new HttpError(400, "INVALID_KEY", "WhatsApp didn't accept this key. Copy it again from the agent's Chat info → API key.");
  if (error instanceof ForbiddenError) return new HttpError(403, "NOT_CREATOR", "Only the person who created the agent can connect it. Create your own agent in WhatsApp.");
  if (error instanceof ConflictError) return new HttpError(409, "KEY_IN_USE", "Another app is already reading this agent. Stop it, or create a new API key in WhatsApp and paste that.");
  if (error instanceof RateLimitedError) return new HttpError(429, "RATE_LIMITED", "WhatsApp asked us to slow down. Please try again in a minute.");
  if (error instanceof AgentError && error.status === 404) return new HttpError(502, "NOT_AVAILABLE", "WhatsApp Agents don't seem to be available for your account yet. Availability depends on Meta's rollout.");
  if (error instanceof NetworkError) return new HttpError(502, "UNREACHABLE", "Couldn't reach WhatsApp. Check your connection and try again; if it keeps failing, Agents may not be available for your account yet.");
  return new HttpError(502, "AGENT_ERROR", "WhatsApp couldn't connect this agent right now. Please try again later.");
}

export type AgentStatus = {
  enabled: boolean;
  pro: boolean;
  connected: boolean;
  status: string | null;
  keyLast4: string | null;
  polling: boolean;
  lastPollAt: string | null;
  rateLimitedUntil: string | null;
  lastError: string | null;
  consentAt: string | null;
  reminders: { setting: string; available: boolean };
  /** available: voice notes are on for this server; ready: the transcriber is reachable right now. */
  voice: { setting: boolean; available: boolean; ready: boolean };
};

export async function agentStatus(userId: string): Promise<AgentStatus> {
  const [row, settings] = await Promise.all([
    prisma.whatsAppAgentConnection.findUnique({ where: { userId } }),
    prisma.userSettings.findUnique({ where: { userId }, select: { waAgentReminders: true, waAgentVoice: true, tier: true } }),
  ]);
  const limited = row?.rateLimitedUntil && row.rateLimitedUntil > new Date() ? row.rateLimitedUntil.toISOString() : null;
  return {
    enabled: agentEnabled(),
    pro: settings?.tier === "PRO",
    connected: row?.status === "CONNECTED",
    status: row?.status ?? null,
    keyLast4: row?.keyLast4 ?? null,
    polling: row ? (getAgentManager()?.isPolling(row.id) ?? false) : false,
    lastPollAt: row?.lastPollAt?.toISOString() ?? null,
    rateLimitedUntil: limited,
    lastError: row?.lastError ?? null,
    consentAt: row?.consentAt.toISOString() ?? null,
    reminders: { setting: settings?.waAgentReminders ?? "BOTH", available: agentRemindersEnabled() },
    voice: { setting: settings?.waAgentVoice ?? true, available: agentVoiceEnabled() && getStt() !== null, ready: agentVoiceEnabled() && (await sttReady(getStt())) },
  };
}

/**
 * Checks the key with one short poll and starts from the newest update: messages sent to the agent before it
 * was connected are skipped, not replayed (up to 4 polls of backlog; anything beyond is acknowledged unread).
 */
async function latestOffset(apiKey: string): Promise<string | null> {
  const client = createAgentClient(apiKey);
  let offset: string | null = null;
  for (let i = 0; i < 4; i += 1) {
    const updates = await client.getUpdates({ offset, limit: POLL_LIMIT, timeoutS: 0 });
    if (!updates.length) break;
    offset = nextOffset(updates[updates.length - 1].id);
    if (updates.length < POLL_LIMIT) break;
  }
  return offset;
}

export async function connectAgent(userId: string, apiKey: string): Promise<AgentStatus> {
  requireAgentFeature();
  await requirePro(userId);
  const key = apiKey.trim();
  const existing = await prisma.whatsAppAgentConnection.findUnique({ where: { userId } });
  // Our own poller would make the check poll a 409: stop it while the new key is checked.
  if (existing) await getAgentManager()?.remove(existing.id);
  let offset: string | null;
  try {
    offset = await latestOffset(key);
  } catch (error) {
    if (existing?.status === "CONNECTED") await getAgentManager()?.add(existing.id);
    throw asHttp(error);
  }
  const data = { encryptedKey: encryptSecret(key, userId), keyLast4: last4(key), status: "CONNECTED", lastOffset: offset, consentAt: new Date(), lastError: null, chatRef: null, rateLimitedUntil: null, lastPollAt: new Date() };
  const row = await prisma.whatsAppAgentConnection.upsert({ where: { userId }, create: { userId, ...data }, update: data });
  // A new key may be a new agent whose update ids start again: forget the old ones.
  await prisma.whatsAppProcessedUpdate.deleteMany({ where: { connectionId: row.id } });
  await getAgentManager()?.add(row.id);
  return agentStatus(userId);
}

export async function disconnectAgent(userId: string): Promise<void> {
  const row = await prisma.whatsAppAgentConnection.findUnique({ where: { userId } });
  if (row) {
    await getAgentManager()?.remove(row.id);
    await prisma.whatsAppAgentConnection.delete({ where: { id: row.id } }); // the key goes with it
  }
  // Reminders go back to the phone by themselves: without a connection nothing is sent on WhatsApp and the plan's
  // viaWhatsappAgent is false. The user's reminder choice is kept for the next connection.
}

export async function connectedRow(userId: string): Promise<WhatsAppAgentConnection> {
  const row = await prisma.whatsAppAgentConnection.findUnique({ where: { userId } });
  if (!row || row.status !== "CONNECTED") throw new HttpError(409, "NOT_CONNECTED", "Connect your WhatsApp agent first");
  return row;
}

export const TEST_MESSAGE = { en: "Life Organizer is connected. Send me a task, e.g. \"Assignment due Friday 3 PM\".", ur: "Life Organizer connect ho gaya. Mujhe task bhejein, jaise \"Friday 3 baje assignment\"." };

export async function sendTestMessage(userId: string, language: string): Promise<void> {
  requireAgentFeature();
  await requirePro(userId);
  const row = await connectedRow(userId);
  const text = language === "ur" ? TEST_MESSAGE.ur : TEST_MESSAGE.en;
  const queued = getAgentManager()?.send(row.id, text, PRIORITY.reply);
  if (!queued) throw new HttpError(503, "NOT_POLLING", "The connection is starting. Try again in a minute.");
  const outcome = await queued;
  if (!outcome.ok) throw asHttp(outcome.error);
}

export async function updateAgentSettings(userId: string, input: { reminders?: "OFF" | "WHATSAPP" | "BOTH"; voice?: boolean }): Promise<AgentStatus> {
  requireAgentFeature();
  if (input.reminders && input.reminders !== "OFF") {
    if (!agentRemindersEnabled()) throw new HttpError(409, "REMINDERS_UNAVAILABLE", "Reminders on WhatsApp are turned off on this server; you'll keep getting them as notifications.");
    await connectedRow(userId);
  }
  if (input.voice && !agentVoiceEnabled()) throw new HttpError(409, "VOICE_UNAVAILABLE", "Voice notes are turned off on this server.");
  await prisma.userSettings.update({ where: { userId }, data: { ...(input.reminders ? { waAgentReminders: input.reminders } : {}), ...(input.voice !== undefined ? { waAgentVoice: input.voice } : {}) } });
  return agentStatus(userId);
}

/** True when the phone should leave task and routine reminders to WhatsApp (mode WHATSAPP, connected, enabled here). */
export async function remindersViaAgent(userId: string): Promise<boolean> {
  if (!agentRemindersEnabled()) return false;
  const [row, settings] = await Promise.all([
    prisma.whatsAppAgentConnection.findUnique({ where: { userId }, select: { status: true } }),
    prisma.userSettings.findUnique({ where: { userId }, select: { waAgentReminders: true, tier: true } }),
  ]);
  return row?.status === "CONNECTED" && settings?.tier === "PRO" && settings.waAgentReminders === "WHATSAPP";
}
