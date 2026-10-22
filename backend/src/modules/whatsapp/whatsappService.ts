import { Prisma, Priority, TaskStatus, type Task, type User, type UserSettings } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { instantLabel } from "../../lib/time.js";
import { addOutboundMessage } from "../conversations/conversationService.js";
import { processDocument } from "../documents/documentProcessing.js";
import { logEvent } from "../events/eventService.js";
import { notifyAddedFromWhatsapp } from "../push/pushService.js";
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
  notifyAddedFromWhatsapp(user.id, [...result.createdTasks, ...result.createdRoutines].map((x) => x.title));
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

/** Global guard against bulk sending; true when sending must stop for now. */
async function bulkPaused(now: Date): Promise<boolean> {
  if (pausedUntil > now.getTime()) return true;
  const recentSends = await prisma.activityEvent.count({ where: { type: "WHATSAPP_SENT", createdAt: { gte: new Date(now.getTime() - 10 * 60000) } } });
  if (recentSends <= BULK_LIMIT) return false;
  pausedUntil = now.getTime() + 3600000;
  console.warn("WhatsApp reminders paused for 1h: bulk sending detected");
  return true;
}

async function overDailyCap(userId: string, now: Date): Promise<boolean> {
  const sentToday = await prisma.activityEvent.count({ where: { userId, type: "WHATSAPP_SENT", createdAt: { gte: new Date(now.getTime() - 24 * 3600000) } } });
  return sentToday >= MAX_WHATSAPP_REMINDERS_PER_DAY;
}

const isActive = (t: Task) => (t.status === TaskStatus.PENDING || t.status === TaskStatus.IN_PROGRESS) && !t.archived && t.reminderMode !== "NONE";

/**
 * Sends one claimed row's message, records the outcome on the row and, when sent, stores it in the
 * WhatsApp chat with focus on the task so "done" / a number reply acts on it.
 * On a transient error the row goes back to `retryStatus` (null = delete it, so the next run claims it again).
 */
async function deliver(
  row: { id: string; userId: string; level: string },
  to: string,
  task: Task,
  body: string,
  actions: Array<{ label: string; payload: Record<string, unknown> }>,
  retryStatus: string | null,
  send: Sender,
): Promise<boolean> {
  const result = await send(to, body);
  if (!result.ok) {
    if (result.twilioCode === TWILIO_WINDOW_CLOSED) {
      await prisma.reminderLog.update({ where: { id: row.id }, data: { status: "SKIPPED" } });
      logEvent(row.userId, "WHATSAPP_SKIPPED_WINDOW", task.id, { level: row.level });
    } else if (result.transient) {
      if (retryStatus) await prisma.reminderLog.update({ where: { id: row.id }, data: { status: retryStatus } });
      else await prisma.reminderLog.delete({ where: { id: row.id } });
    } else {
      await prisma.reminderLog.update({ where: { id: row.id }, data: { status: "FAILED" } });
    }
    return false;
  }
  await prisma.reminderLog.update({ where: { id: row.id }, data: { status: "SENT_WHATSAPP" } });
  await addOutboundMessage(row.userId, "WHATSAPP", body, { focusTaskId: task.id, actions });
  logEvent(row.userId, "WHATSAPP_SENT", task.id, { level: row.level });
  return true;
}

const doneAction = (taskId: string) => ({ label: "Done", payload: { type: "complete_task", taskId } });
const snoozeAction = (taskId: string) => ({ label: "Snooze 1h", payload: { type: "snooze_task", taskId, minutes: 60 } });

/**
 * Sends due reminders (planned ones and WhatsApp snoozes) over WhatsApp. Each row is claimed atomically
 * first, so overlapping runs never double-send.
 */
export async function sendDueWhatsappReminders(now = new Date(), send: Sender = sendWhatsapp): Promise<number> {
  if ((send === sendWhatsapp && !twilioConfigured()) || (await bulkPaused(now))) return 0;
  const due = await prisma.reminderLog.findMany({
    where: { status: { in: ["SCHEDULED", "SNOOZED"] }, taskId: { not: null }, fireAt: { lte: now, gte: new Date(now.getTime() - SEND_LATENESS_MS) }, user: eligibleWhere(now) },
    include: { user: { include: { settings: true } } },
    orderBy: { fireAt: "asc" },
    take: 100,
  });
  let sent = 0;
  for (const r of due) {
    const claimed = await prisma.reminderLog.updateMany({ where: { id: r.id, status: r.status }, data: { status: "SENDING" } });
    if (claimed.count !== 1) continue;
    const s = r.user.settings as UserSettings;
    const task = await prisma.task.findFirst({ where: { id: r.taskId as string, userId: r.userId } });
    const onTime = Boolean(task?.dueAt && Math.abs(task.dueAt.getTime() - r.fireAt.getTime()) < 60000 && (r.level === "critical" || r.level === SNOOZE_LEVEL));
    // Quiet hours, DND and placement are judged at the PLANNED time: the job runs up to 5 min late, and judging
    // an on-time "due now" reminder at run time would always reject it. The 24 h window is judged at send time (query above).
    const allowed = task && isActive(task) && stillAllowedAt(r.fireAt, (r.level === SNOOZE_LEVEL ? "normal" : r.level) as ReminderLevel, onTime, task.dueAt, s, s.timezone);
    if (!task || !allowed || (await overDailyCap(r.userId, now))) {
      await prisma.reminderLog.update({ where: { id: r.id }, data: { status: "SKIPPED" } });
      continue;
    }
    const dueText = task.dueAt ? ` is due ${instantLabel(task.dueAt, s.timezone, now)}` : "";
    const body = `Reminder: ${task.title}${dueText}.\n\n1. Done\n2. Snooze 1h\n\nReply done or snooze 1h.`;
    if (await deliver(r, r.user.phoneNumber as string, task, body, [doneAction(task.id), snoozeAction(task.id)], r.status, send)) sent += 1;
  }
  return sent;
}

/* ------------------------------------------------------------------ urgent alerts (P3) */

/** "Urgent" = due within this long. */
export const URGENT_WITHIN_MS = 3 * 3600000;
const URGENT_LEVEL = "URGENT";
export const SNOOZE_LEVEL = "SNOOZE";

/** A pending (not started, done, skipped or deleted), high or urgent priority task due within the next 3 hours. */
export function isUrgent(task: Pick<Task, "status" | "priority" | "dueAt" | "archived">, now: Date): boolean {
  if (task.status !== TaskStatus.PENDING || task.archived || !task.dueAt) return false;
  if (task.priority !== Priority.HIGH && task.priority !== Priority.URGENT) return false;
  const left = task.dueAt.getTime() - now.getTime();
  return left > 0 && left <= URGENT_WITHIN_MS;
}

/**
 * One WhatsApp message per urgent task (Pro, verified number, WhatsApp allowed in notification devices).
 * Outside the 24 h window it is not sent and not claimed (WHATSAPP_SKIPPED_WINDOW, logged once per task); it is
 * checked again on later runs, so if the user messages while it is still urgent, the alert goes out then.
 * Quiet hours, DND and the daily cap hold it back; it is tried again on the next run while still urgent.
 * Dedupe: a ReminderLog row with level URGENT at dueAt − 1 s (unique per task; never a planned reminder's time).
 */
export async function sendUrgentWhatsappAlerts(now = new Date(), send: Sender = sendWhatsapp): Promise<number> {
  if ((send === sendWhatsapp && !twilioConfigured()) || (await bulkPaused(now))) return 0;
  const tasks = await prisma.task.findMany({
    where: {
      status: TaskStatus.PENDING,
      archived: false,
      priority: { in: [Priority.HIGH, Priority.URGENT] },
      reminderMode: { not: "NONE" },
      dueAt: { gt: now, lte: new Date(now.getTime() + URGENT_WITHIN_MS) },
      user: { phoneNumber: { not: null }, phoneVerifiedAt: { not: null }, settings: { tier: "PRO", notificationDevices: { in: ["ALL", "WHATSAPP"] } } },
    },
    include: { user: { include: { settings: true } } },
    take: 200,
  });
  let sent = 0;
  for (const task of tasks) {
    if (!isUrgent(task, now)) continue;
    if (await prisma.reminderLog.findFirst({ where: { taskId: task.id, level: URGENT_LEVEL }, select: { id: true } })) continue;
    const s = task.user.settings as UserSettings;
    const fireAt = new Date((task.dueAt as Date).getTime() - 1000);
    const inWindow = s.lastWhatsappMessageAt && s.lastWhatsappMessageAt.getTime() >= now.getTime() - WINDOW_MS;
    if (!inWindow) {
      // Nothing is claimed, so a message later on (window open again) still gets the alert. Logged once per task.
      const logged = await prisma.activityEvent.findFirst({ where: { userId: task.userId, entityId: task.id, type: "WHATSAPP_SKIPPED_WINDOW" }, select: { id: true } });
      if (!logged) await prisma.activityEvent.create({ data: { userId: task.userId, type: "WHATSAPP_SKIPPED_WINDOW", entityId: task.id, payload: { level: URGENT_LEVEL } } });
      continue;
    }
    if (!stillAllowedAt(now, "urgent", false, task.dueAt, s, s.timezone) || (await overDailyCap(task.userId, now))) continue;
    const row = await claimRow(task.userId, task.id, fireAt, URGENT_LEVEL, "SENDING");
    if (!row) continue;
    const body = `Urgent: ${task.title} is due ${instantLabel(task.dueAt as Date, s.timezone, now)}.\n\n1. Done\n2. Snooze 1h\n\nReply done or snooze 1h.`;
    if (await deliver({ id: row, userId: task.userId, level: URGENT_LEVEL }, task.user.phoneNumber as string, task, body, [doneAction(task.id), snoozeAction(task.id)], null, send)) sent += 1;
  }
  return sent;
}

/** Inserts a ReminderLog row; null when another run already has it (unique userId + taskId + fireAt). */
export async function claimRow(userId: string, taskId: string, fireAt: Date, level: string, status: string): Promise<string | null> {
  try {
    return (await prisma.reminderLog.create({ data: { userId, taskId, fireAt, level, status } })).id;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null;
    throw error;
  }
}

/** Test hook. */
export function resetWhatsappPause(): void {
  pausedUntil = 0;
}
