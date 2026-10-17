import { TaskStatus, type User, type UserSettings } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { instantLabel } from "../../lib/time.js";
import { addOutboundMessage } from "../conversations/conversationService.js";
import { processDocument } from "../documents/documentProcessing.js";
import { logEvent } from "../events/eventService.js";
import { planReminders, stillAllowedAt, type ReminderLevel } from "../reminders/reminderService.js";

export function twilioConfigured(): boolean {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM);
}

function authHeader(): string {
  return `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}`;
}

/** Twilio: "freeform message outside the 24-hour customer service window". */
export const TWILIO_WINDOW_CLOSED = 63016;
const MAX_PART = 1500;

export type SendResult = { ok: boolean; twilioCode: number | null; transient?: boolean };
export type Sender = (to: string, body: string) => Promise<SendResult>;

/** Splits on paragraph, line or word boundaries so no part is longer than `max`. */
export function splitMessage(body: string, max = MAX_PART): string[] {
  const parts: string[] = [];
  let rest = body.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = cut > max / 2 ? cut : max;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Sends a WhatsApp message through the Twilio REST API. Never throws: failures are logged and returned
 * with Twilio's error code. `transient` = worth retrying (network error, 429, 5xx).
 */
export const sendWhatsapp: Sender = async (to, body) => {
  if (!twilioConfigured()) return { ok: false, twilioCode: null };
  for (const part of splitMessage(body)) {
    try {
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
        method: "POST",
        headers: { Authorization: authHeader(), "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ From: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`, To: `whatsapp:${to}`, Body: part }).toString(),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { code?: number; message?: string };
        console.warn(`WhatsApp send failed (HTTP ${response.status}, Twilio ${err.code ?? "?"}): ${err.message ?? ""}`);
        return { ok: false, twilioCode: err.code ?? null, transient: response.status === 429 || response.status >= 500 };
      }
    } catch (error) {
      console.warn("WhatsApp send failed:", error instanceof Error ? error.message : error);
      return { ok: false, twilioCode: null, transient: true };
    }
  }
  return { ok: true, twilioCode: null };
};

/** Image/PDF sent on WhatsApp → OCR + extraction, summarised as a reply (FR-WA-001 §1). */
export async function processDocumentForWhatsapp(user: User, settings: UserSettings, mediaUrl: string, mediaType: string): Promise<string> {
  if (!twilioConfigured()) return "I can't download files right now. Please upload it in the app (Documents).";
  const response = await fetch(mediaUrl, { headers: { Authorization: authHeader() }, signal: AbortSignal.timeout(30000) }).catch(() => null);
  if (!response?.ok) return "I couldn't download that file. Please try again.";
  const buffer = Buffer.from(await response.arrayBuffer());
  const result = await processDocument(user, settings, {
    buffer,
    fileName: mediaType === "application/pdf" ? "whatsapp.pdf" : "whatsapp.jpg",
    mimeType: mediaType,
    docType: "OTHER",
    language: "eng",
    autoCreate: true,
  });
  const created = result.createdTasks.length + result.createdRoutines.length;
  const pending = result.extracted.deadlines.filter((d) => !d.created).length + result.extracted.schedules.filter((s) => !s.created).length;
  if (result.extracted.warning && !created) return result.extracted.warning;
  return `Read your document. Created ${created} item${created === 1 ? "" : "s"}${pending ? `; ${pending} more need your review in the app (Documents).` : "."}`;
}

/* ------------------------------------------------------------------ reminders (FR-WA-002) */

const WINDOW_MS = 24 * 3600000;
const STALE_PLAN_MS = 6 * 3600000;
/** Reminders older than this when the job sees them are left to the phone. */
const SEND_LATENESS_MS = 6 * 60000;
/** Per user, per rolling 24 h. */
export const MAX_WHATSAPP_REMINDERS_PER_DAY = 10;
/** Whole backend, per 10 minutes: protects the business number from being flagged for bulk sending. */
const BULK_LIMIT = 50;

let pausedUntil = 0;

/** Who may get WhatsApp reminders right now: Pro, verified number, inside Twilio's 24 h window, WhatsApp allowed. */
function eligibleWhere(now: Date) {
  return {
    phoneNumber: { not: null },
    phoneVerifiedAt: { not: null },
    settings: { tier: "PRO", notificationDevices: { in: ["ALL", "WHATSAPP"] }, lastWhatsappMessageAt: { gte: new Date(now.getTime() - WINDOW_MS) } },
  };
}

/**
 * The reminder plan (ReminderLog SCHEDULED rows) is normally rebuilt when the phone asks for it. For
 * WhatsApp users the server rebuilds it too: when a task changed after the last plan, or the plan is
 * older than 6 h. Same planner as the app, so quiet hours, DND and per-task settings are identical.
 */
export async function replanStaleWhatsappUsers(now = new Date()): Promise<number> {
  const users = await prisma.user.findMany({ where: eligibleWhere(now), include: { settings: true } });
  let replanned = 0;
  for (const u of users) {
    const s = u.settings as UserSettings;
    const last = s.remindersPlannedAt;
    const stale = !last || now.getTime() - last.getTime() > STALE_PLAN_MS || (await prisma.task.count({ where: { userId: u.id, updatedAt: { gt: last } } })) > 0;
    if (!stale) continue;
    await planReminders(u.id, s, now);
    replanned += 1;
  }
  return replanned;
}

/** Sends due reminders over WhatsApp. Each row is claimed atomically first, so overlapping runs never double-send. */
export async function sendDueWhatsappReminders(now = new Date(), send: Sender = sendWhatsapp): Promise<number> {
  if ((send === sendWhatsapp && !twilioConfigured()) || pausedUntil > now.getTime()) return 0;
  const recentSends = await prisma.activityEvent.count({ where: { type: "WHATSAPP_SENT", createdAt: { gte: new Date(now.getTime() - 10 * 60000) } } });
  if (recentSends > BULK_LIMIT) {
    pausedUntil = now.getTime() + 3600000;
    console.warn("WhatsApp reminders paused for 1h: bulk sending detected");
    return 0;
  }
  const due = await prisma.reminderLog.findMany({
    where: { status: "SCHEDULED", taskId: { not: null }, fireAt: { lte: now, gte: new Date(now.getTime() - SEND_LATENESS_MS) }, user: eligibleWhere(now) },
    include: { user: { include: { settings: true } } },
    orderBy: { fireAt: "asc" },
    take: 100,
  });
  let sent = 0;
  for (const r of due) {
    const claimed = await prisma.reminderLog.updateMany({ where: { id: r.id, status: "SCHEDULED" }, data: { status: "SENDING" } });
    if (claimed.count !== 1) continue;
    const finish = (status: string) => prisma.reminderLog.update({ where: { id: r.id }, data: { status } });
    const s = r.user.settings as UserSettings;
    const task = await prisma.task.findFirst({ where: { id: r.taskId as string, userId: r.userId } });
    const active = task && (task.status === TaskStatus.PENDING || task.status === TaskStatus.IN_PROGRESS) && !task.archived && task.reminderMode !== "NONE";
    const onTime = Boolean(task?.dueAt && Math.abs(task.dueAt.getTime() - r.fireAt.getTime()) < 60000 && r.level === "critical");
    // Quiet hours, DND and placement are judged at the PLANNED time: the job runs up to 5 min late, and judging
    // an on-time "due now" reminder at run time would always reject it. The 24 h window is judged at send time (query above).
    if (!task || !active || !stillAllowedAt(r.fireAt, r.level as ReminderLevel, onTime, task.dueAt, s, s.timezone)) {
      await finish("SKIPPED");
      continue;
    }
    const sentToday = await prisma.activityEvent.count({ where: { userId: r.userId, type: "WHATSAPP_SENT", createdAt: { gte: new Date(now.getTime() - 24 * 3600000) } } });
    if (sentToday >= MAX_WHATSAPP_REMINDERS_PER_DAY) {
      await finish("SKIPPED");
      continue;
    }
    const due = task.dueAt ? ` is due ${instantLabel(task.dueAt, s.timezone, now)}` : "";
    const body = `Reminder: ${task.title}${due}.\n\n1. Done\n\nReply 1 or "done" when it's finished.`;
    const result = await send(r.user.phoneNumber as string, body);
    if (!result.ok) {
      // A closed 24 h window won't open by retrying; anything else permanent is FAILED; transient errors retry next run.
      await finish(result.twilioCode === TWILIO_WINDOW_CLOSED ? "SKIPPED" : result.transient ? "SCHEDULED" : "FAILED");
      continue;
    }
    await finish("SENT_WHATSAPP");
    // Stored in the WhatsApp conversation with focus on the task, so "done" or "1" completes this task.
    await addOutboundMessage(r.userId, "WHATSAPP", body, { focusTaskId: task.id, actions: [{ label: "Done", payload: { type: "complete_task", taskId: task.id } }] });
    logEvent(r.userId, "WHATSAPP_SENT", task.id, { level: r.level });
    sent += 1;
  }
  return sent;
}

/** Test hook. */
export function resetWhatsappPause(): void {
  pausedUntil = 0;
}
