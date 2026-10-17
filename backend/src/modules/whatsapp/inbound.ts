import crypto from "node:crypto";
import { ConversationRole, Prisma } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { ensureSettings } from "../../lib/http.js";
import { handleAssistantMessage } from "../assistant/dialogue.js";
import type { ActionPayload, QuickAction } from "../assistant/types.js";
import { logEvent } from "../events/eventService.js";
import { LINK_FAILED_REPLY, LINKED_REPLY, normalizeNumber, parseLinkCommand, tryLink } from "./linking.js";
import { processDocumentForWhatsapp, sendWhatsapp, type Sender } from "./whatsappService.js";

/**
 * FR-WA-001 inbound pipeline. The webhook only checks the signature, records the MessageSid (so Twilio
 * retries are dropped) and answers with an empty TwiML; the work happens here, one message at a time per
 * number, and the answer goes out through the REST API. Everything on WhatsApp is Pro-only.
 */

export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
export const UNLINKED_REPLY = 'Hi! This number isn\'t linked to a Life Organizer account. In the app, open Settings → WhatsApp, tap "Get link code" and send me the LINK message shown there.';
export const PRO_ONLY_REPLY = "WhatsApp is a Pro feature of Life Organizer. You can keep using the app as usual.";
export const MISSED_REPLY = "Sorry, I missed that, please resend.";
export const VOICE_REPLY = "Voice notes aren't supported on WhatsApp yet. Please type your message, or use voice in the app.";

export type InboundMessage = { sid: string; from: string; body: string; numMedia: number; mediaType: string; mediaUrl: string };

/** Twilio's request signature: HMAC-SHA1 over the full URL plus the sorted POST params, base64. */
export function twilioSignatureValid(url: string, params: Record<string, string>, signature: string | undefined, token: string): boolean {
  if (!signature) return false;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = Buffer.from(crypto.createHmac("sha1", token).update(Buffer.from(data, "utf-8")).digest("base64"));
  const given = Buffer.from(signature);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** True the first time a MessageSid is seen; false for a Twilio retry of the same message. */
export async function recordInbound(sid: string, fromNumber: string): Promise<boolean> {
  try {
    await prisma.whatsappInbound.create({ data: { messageSid: sid, fromNumber } });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
    throw error;
  }
}

// ponytail: in-memory, per server process. Queues and reply throttles are lost on restart (the stuck-message
// sweep covers lost work); move to the database or Redis if the backend runs as several instances.
const queues = new Map<string, Promise<void>>();
const lastNotice = new Map<string, number>();

/** Runs jobs for the same key one after another, so rapid messages don't race on conversation state. */
export function enqueue(key: string, job: () => Promise<void>): Promise<void> {
  const run = (queues.get(key) ?? Promise.resolve()).then(job).catch((error) => console.error("WhatsApp job failed", error));
  queues.set(key, run);
  void run.finally(() => {
    if (queues.get(key) === run) queues.delete(key);
  });
  return run;
}

/** True at most once per `ms` for a key (and records it). */
function noticeDue(key: string, ms: number, now: number): boolean {
  const last = lastNotice.get(key);
  if (last !== undefined && now - last < ms) return false;
  lastNotice.set(key, now);
  return true;
}

/** Test hook. */
export function resetInboundState(): void {
  queues.clear();
  lastNotice.clear();
}

async function lastActions(userId: string): Promise<QuickAction[]> {
  const last = await prisma.conversationMessage.findFirst({
    where: { userId, role: ConversationRole.ASSISTANT, conversation: { channel: "WHATSAPP" } },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  const meta = last?.metadata as { actions?: QuickAction[] } | null;
  return Array.isArray(meta?.actions) ? meta.actions : [];
}

/** WhatsApp has no buttons: quick actions become a numbered list the user can answer with "1", "2", … */
export function formatReply(content: string, actions: QuickAction[]): string {
  const usable = actions.filter((a) => !(a.payload && ["open_task", "navigate", "breathing"].includes(a.payload.type))).slice(0, 5);
  if (!usable.length) return content;
  return `${content}\n\n${usable.map((a, i) => `${i + 1}. ${a.label}`).join("\n")}`;
}

/** Handles one recorded message and marks it DONE. Never throws. */
export async function processInbound(msg: InboundMessage, send: Sender = sendWhatsapp, now = new Date()): Promise<void> {
  const from = normalizeNumber(msg.from);
  try {
    if (!from) return;
    const reply = (text: string) => send(from, text);

    const code = parseLinkCommand(msg.body);
    if (code !== null) {
      const r = await tryLink(from, code, now);
      if (r.kind === "linked") {
        await prisma.userSettings.updateMany({ where: { userId: r.userId }, data: { lastWhatsappMessageAt: now } });
        await reply(LINKED_REPLY);
      } else if (r.kind === "failed") {
        await reply(LINK_FAILED_REPLY);
      } // locked: too many failures from this number; stay silent
      return;
    }

    const user = await prisma.user.findFirst({ where: { phoneNumber: from, phoneVerifiedAt: { not: null } } });
    if (!user) {
      if (noticeDue(`unlinked:${from}`, 3600000, now.getTime())) await reply(UNLINKED_REPLY);
      return;
    }
    const current = await ensureSettings(user.id);
    if (current.tier !== "PRO") {
      if (noticeDue(`free:${from}`, 24 * 3600000, now.getTime())) await reply(PRO_ONLY_REPLY);
      return;
    }
    const settings = await prisma.userSettings.update({ where: { userId: user.id }, data: { lastWhatsappMessageAt: now } });
    logEvent(user.id, "WHATSAPP_RECEIVED", null, { hasMedia: msg.numMedia > 0 });

    if (msg.numMedia > 0) {
      if (msg.mediaType.startsWith("audio/")) return void (await reply(VOICE_REPLY));
      if (msg.mediaType.startsWith("image/") || msg.mediaType === "application/pdf") {
        return void (await reply(await processDocumentForWhatsapp(user, settings, msg.mediaUrl, msg.mediaType)));
      }
    }
    const body = msg.body.trim();
    if (!body) return void (await reply('Send me a message like "Add assignment due Friday 3 PM" or "What\'s due today?"'));

    // A number or an exact label answers the previous message's options.
    const actions = await lastActions(user.id);
    const n = /^\d$/.test(body) ? Number(body) : NaN;
    const picked = Number.isInteger(n) && n >= 1 && n <= actions.length ? actions[n - 1] : actions.find((a) => a.label.toLowerCase() === body.toLowerCase());
    const answer = await handleAssistantMessage({
      user,
      settings,
      deviceId: "whatsapp",
      text: picked?.payload ? null : (picked?.text ?? body),
      payload: (picked?.payload as ActionPayload | undefined) ?? null,
      label: picked?.label ?? null,
      channel: "WHATSAPP",
    });
    await reply(formatReply(answer.message.content, answer.message.actions ?? []));
  } catch (error) {
    console.error("WhatsApp message failed", error);
    if (from) await send(from, "Sorry, something went wrong. Please try again.");
  } finally {
    await prisma.whatsappInbound.updateMany({ where: { messageSid: msg.sid }, data: { status: "DONE" } }).catch(() => undefined);
  }
}

/** Messages still RECEIVED after 2 minutes were lost (restart, crash): ask the sender to resend. */
export async function recoverStuckInbound(now = new Date(), send: Sender = sendWhatsapp): Promise<number> {
  const stuck = await prisma.whatsappInbound.findMany({ where: { status: "RECEIVED", createdAt: { lt: new Date(now.getTime() - 2 * 60000) } }, take: 100 });
  let recovered = 0;
  for (const row of stuck) {
    const claimed = await prisma.whatsappInbound.updateMany({ where: { messageSid: row.messageSid, status: "RECEIVED" }, data: { status: "DONE" } });
    if (claimed.count !== 1) continue;
    const to = normalizeNumber(row.fromNumber);
    if (to) await send(to, MISSED_REPLY);
    recovered += 1;
  }
  return recovered;
}

export async function purgeOldInbound(now = new Date()): Promise<number> {
  return (await prisma.whatsappInbound.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 7 * 86400000) } } })).count;
}
