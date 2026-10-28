import { ConversationRole, type Prisma, type Task, type UserSettings } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { respectQuietHours, stillAllowedAt } from "../reminders/reminderService.js";
import { claimRow, SNOOZE_LEVEL } from "./whatsappService.js";

/**
 * "Snooze 1h" in reply to a WhatsApp reminder (P3). A snooze is a ReminderLog row with level SNOOZE and
 * status SNOOZED; the plan rebuild (recordPlan) only deletes SCHEDULED rows, so it survives re-plans.
 * The WhatsApp job sends it like a reminder, re-checking the 24 h window, quiet hours and DND.
 */

export const SNOOZE_MIN_MINUTES = 15;
export const SNOOZE_MAX_MINUTES = 240;
export const SNOOZE_DEFAULT_MINUTES = 60;
export const MAX_SNOOZES_PER_TASK = 3;
/** Only a reminder sent within this long can be snoozed. */
export const SNOOZE_REMINDER_WINDOW_MS = 6 * 3600000;

/**
 * The task of the latest WhatsApp reminder (or urgent alert) sent in the last 6 hours, or, with `taskId`,
 * that task if it was reminded in that time. Null = nothing to snooze.
 */
/** `channel`: the WhatsApp conversation the reminder went to (Twilio "WHATSAPP" or the user's agent "WHATSAPP_AGENT"). */
export async function recentlyRemindedTaskId(userId: string, now: Date, taskId?: string, channel = "WHATSAPP"): Promise<string | null> {
  const filters: Prisma.ConversationMessageWhereInput[] = [{ metadata: { path: ["intent"], equals: "reminder" } }];
  if (taskId) filters.push({ metadata: { path: ["taskId"], equals: taskId } });
  const last = await prisma.conversationMessage.findFirst({
    where: { userId, role: ConversationRole.ASSISTANT, conversation: { channel }, createdAt: { gte: new Date(now.getTime() - SNOOZE_REMINDER_WINDOW_MS) }, AND: filters },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  const id = (last?.metadata as { taskId?: unknown } | null)?.taskId;
  return typeof id === "string" ? id : null;
}

/** "snooze" → 60, "snooze 30m", "snooze 2 hours", "snooze for 45 min", "snooze 90" (minutes); null otherwise. */
export function parseSnooze(text: string): number | null {
  const m = /^\s*snooze(?:\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?)?)?\s*[.!]?\s*$/i.exec(text);
  if (!m) return null;
  if (!m[1]) return SNOOZE_DEFAULT_MINUTES;
  const n = Number(m[1]);
  return Math.round(/^h/i.test(m[2] ?? "") ? n * 60 : n);
}

export type SnoozeResult =
  | { ok: true; at: Date; atDueTime: boolean; minutes: number; movedFor: "quiet" | "dnd" | null }
  | { ok: false; reason: "limit" | "due" | "muted" };

/**
 * Clamped to 15 min–4 h and never past the due time; refused after 3 snoozes. A time inside quiet hours or
 * Do Not Disturb is moved to when they end (the reply says so); refused ("muted") only if that is after the due time.
 */
export async function snoozeTask(task: Task, requestedMinutes: number, settings: UserSettings, now = new Date()): Promise<SnoozeResult> {
  const used = await prisma.reminderLog.count({ where: { taskId: task.id, level: SNOOZE_LEVEL } });
  if (used >= MAX_SNOOZES_PER_TASK) return { ok: false, reason: "limit" };
  const minutes = Math.min(SNOOZE_MAX_MINUTES, Math.max(SNOOZE_MIN_MINUTES, requestedMinutes));
  let at = new Date(now.getTime() + minutes * 60000);
  let atDueTime = false;
  if (task.dueAt) {
    if (task.dueAt.getTime() - now.getTime() < 60000) return { ok: false, reason: "due" };
    if (at > task.dueAt) {
      at = task.dueAt;
      atDueTime = true;
    }
  }
  let movedFor: "quiet" | "dnd" | null = null;
  if (!stillAllowedAt(at, "normal", atDueTime, task.dueAt, settings, settings.timezone)) {
    // Twice: DND can end inside quiet hours and the other way round.
    for (let i = 0; i < 2; i += 1) {
      if (settings.dndUntil && at < settings.dndUntil) [at, movedFor] = [settings.dndUntil, "dnd"];
      const outOfQuiet = respectQuietHours(at, null, settings, settings.timezone);
      if (outOfQuiet.getTime() !== at.getTime()) [at, movedFor] = [outOfQuiet, "quiet"];
    }
    atDueTime = Boolean(task.dueAt && at.getTime() === task.dueAt.getTime());
    if ((task.dueAt && at > task.dueAt) || !stillAllowedAt(at, "normal", atDueTime, task.dueAt, settings, settings.timezone)) return { ok: false, reason: "muted" };
  }
  // A row at exactly this instant can only clash with another snooze created the same millisecond.
  const id = (await claimRow(task.userId, task.id, at, SNOOZE_LEVEL, "SNOOZED")) ?? (await claimRow(task.userId, task.id, new Date(at.getTime() + 1), SNOOZE_LEVEL, "SNOOZED"));
  if (!id) return { ok: false, reason: "limit" };
  return { ok: true, at, atDueTime, minutes, movedFor };
}
