import { TaskStatus, TaskType, type Task, type UserSettings } from "@prisma/client";
import { inWindow, localParts, localYmd, minutesOfDay, parseClock } from "../../lib/time.js";

/**
 * FR-RN-004 start & completion check-ins — pure timing rules (no I/O, fully unit-tested).
 * Persistence, copy and the respond endpoint build on these.
 */

export const CHECKIN_KINDS = ["START", "START_FOLLOWUP", "COMPLETION", "COMPLETION_EXTRA"] as const;
export type CheckinKind = (typeof CHECKIN_KINDS)[number];
export const CHECKIN_TONES = ["FUNNY", "SERIOUS", "GENTLE"] as const;
export type CheckinTone = (typeof CHECKIN_TONES)[number];

/** Minutes after scheduledStart for the start check-in, and after that for the single follow-up. */
export const START_DELAY_MIN = 5;
export const FOLLOWUP_DELAY_MIN = 25;
/** Planned check-ins (START, START_FOLLOWUP, COMPLETION) per task and per user per local day. */
export const MAX_PLANNED_PER_TASK = 3;
export const MAX_PLANNED_PER_DAY = 5;
/** User-requested extra time (+15/+30/+60) is exempt from both caps but limited per slot. */
export const MAX_EXTRAS_PER_SLOT = 2;
const GENTLE_MOODS: ReadonlySet<string> = new Set(["stressed", "anxious", "overwhelmed", "sad"]);

/** `slotStart` = the scheduledStart the check-in was planned for. */
export type CheckinHistory = { kind: CheckinKind | string; fireAt: Date; slotStart: Date; status: string; response: string | null };
export type PlannedCheckin = { kind: CheckinKind; fireAt: Date; unconfirmed: boolean };
type TaskLike = Pick<Task, "status" | "archived" | "taskType" | "scheduledStart" | "durationMinutes" | "startedAt" | "dueAt">;
type SettingsLike = Pick<UserSettings, "checkinsEnabled" | "notificationFrequency" | "quietStart" | "quietEnd">;

const addMin = (d: Date, m: number) => new Date(d.getTime() + m * 60000);

/** Grace after the expected end: max(10 min, 10% of the duration). */
export function completionBufferMinutes(durationMinutes: number): number {
  return Math.max(10, Math.ceil(durationMinutes * 0.1));
}

export function completionFireAt(base: Date, durationMinutes: number): Date {
  return addMin(base, durationMinutes + completionBufferMinutes(durationMinutes));
}

/** True when the task was moved to a later start after work began (excluded from estimate accuracy). */
export function rescheduledAfterStart(task: Pick<Task, "startedAt" | "scheduledStart">): boolean {
  return Boolean(task.startedAt && task.scheduledStart && task.scheduledStart > task.startedAt);
}

/** Start of the work the completion check-in measures: startedAt, unless rescheduled to a later start since. */
export function completionBase(task: Pick<Task, "startedAt" | "scheduledStart">): Date {
  if (rescheduledAfterStart(task)) return task.scheduledStart as Date;
  return (task.startedAt ?? task.scheduledStart) as Date;
}

/** Which check-ins a task may receive at all (FR-RN-004 §1). */
export function checkinEligibility(task: TaskLike, settings: SettingsLike, now: Date): { start: boolean; completion: boolean } {
  const none = { start: false, completion: false };
  if (!settings.checkinsEnabled || settings.notificationFrequency === "NONE") return none;
  if (task.archived || (task.status !== TaskStatus.PENDING && task.status !== TaskStatus.IN_PROGRESS)) return none;
  // DEADLINE tasks qualify only with a work block (scheduledStart) and a duration; the deadline is separate.
  const deadlineWithBlock = task.taskType === TaskType.DEADLINE && Boolean(task.durationMinutes);
  if (task.taskType !== TaskType.FLEXIBLE && task.taskType !== TaskType.DURATION && !deadlineWithBlock) return none;
  if (!task.scheduledStart) return none;
  // A passed deadline belongs to the overdue flow (FR-TM-008), never a check-in.
  if (task.dueAt && task.dueAt <= now) return none;
  return {
    start: task.status === TaskStatus.PENDING && !task.startedAt,
    completion: Boolean(task.durationMinutes && task.durationMinutes > 0),
  };
}

/** Quiet hours and DND make a check-in skip — it is never moved (FR-RN-004 §4). */
export function isMuted(at: Date, settings: Pick<UserSettings, "quietStart" | "quietEnd">, tz: string, dndUntil: Date | null): boolean {
  if (dndUntil && at < dndUntil) return true;
  const start = parseClock(settings.quietStart);
  const end = parseClock(settings.quietEnd);
  if (!start || !end) return false;
  const p = localParts(at, tz);
  return inWindow(p.h * 60 + p.mi, minutesOfDay(start), minutesOfDay(end));
}

/**
 * Upcoming planned check-ins for one task, before the daily cap. `history` holds this task's
 * logged check-ins; only those for the current slot (same scheduledStart) count, so a task
 * rescheduled after "Not today" or a partial completion gets a fresh set for its new slot.
 */
export function planTaskCheckins(task: TaskLike, settings: SettingsLike, tz: string, now: Date, dndUntil: Date | null, history: CheckinHistory[] = []): PlannedCheckin[] {
  const ok = checkinEligibility(task, settings, now);
  if (!ok.start && !ok.completion) return [];
  const start = task.scheduledStart as Date;
  const live = history.filter((h) => h.status !== "CANCELLED" && h.slotStart.getTime() === start.getTime());
  const answered = (kind: string) => live.find((h) => h.kind === kind && h.status === "ANSWERED");
  // "Not today" ends check-ins for this slot; the user reschedules if they want.
  if (live.some((h) => h.response === "NOT_TODAY") || answered("COMPLETION")) return [];

  const out: PlannedCheckin[] = [];
  if (ok.start && !answered("START") && !answered("START_FOLLOWUP")) {
    const first = addMin(start, START_DELAY_MIN);
    out.push({ kind: "START", fireAt: first, unconfirmed: true });
    out.push({ kind: "START_FOLLOWUP", fireAt: addMin(first, FOLLOWUP_DELAY_MIN), unconfirmed: true });
  }
  if (ok.completion) {
    const base = completionBase(task);
    out.push({ kind: "COMPLETION", fireAt: completionFireAt(base, task.durationMinutes as number), unconfirmed: !task.startedAt });
  }
  // Short tasks: a follow-up that lands at (or within 10 min of) the completion check-in is noise.
  const followup = out.find((c) => c.kind === "START_FOLLOWUP");
  const completion = out.find((c) => c.kind === "COMPLETION");
  const planned = followup && completion && completion.fireAt.getTime() <= followup.fireAt.getTime() + 10 * 60000 ? out.filter((c) => c !== followup) : out;

  // Per-task cap counts check-ins that already fired plus the ones still to come.
  const firedPlanned = live.filter((h) => h.kind !== "COMPLETION_EXTRA" && h.fireAt <= now).length;
  return planned
    // After the deadline the overdue flow (FR-TM-008) takes over.
    .filter((c) => c.fireAt > now && !(task.dueAt && c.fireAt > task.dueAt) && !isMuted(c.fireAt, settings, tz, dndUntil))
    .filter((c) => !live.some((h) => h.kind === c.kind && h.fireAt.getTime() === c.fireAt.getTime() && h.status !== "SCHEDULED"))
    .slice(0, Math.max(0, MAX_PLANNED_PER_TASK - firedPlanned));
}

/**
 * Applies the per-user daily cap (5 per local day) across all tasks. When a day is over the cap,
 * start follow-ups are dropped first (latest first), then the rest is kept soonest-first.
 * `alreadyByDay` counts planned check-ins that already fired on each local day.
 */
export function applyDailyCap<T extends { fireAt: Date; kind: string }>(planned: T[], tz: string, alreadyByDay: Map<string, number> = new Map()): T[] {
  const byDay = new Map<string, T[]>();
  for (const c of [...planned].sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime())) {
    const day = localYmd(c.fireAt, tz);
    byDay.set(day, [...(byDay.get(day) ?? []), c]);
  }
  const out: T[] = [];
  for (const [day, items] of byDay) {
    const room = Math.max(0, MAX_PLANNED_PER_DAY - (alreadyByDay.get(day) ?? 0));
    let keep = items;
    for (let i = keep.length - 1; keep.length > room && i >= 0; i -= 1) {
      if (keep[i].kind === "START_FOLLOWUP") keep = keep.filter((_, j) => j !== i);
    }
    out.push(...keep.slice(0, room));
  }
  return out.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
}

export type ExtraRequest =
  | { ok: true; fireAt: Date; passesDeadline: boolean }
  | { ok: false; reason: "limit" | "quiet_hours" | "dnd" | "past_deadline" };

/**
 * User asked for more time (+15/+30/+60). Exempt from both caps, max 2 per slot (current
 * scheduledStart). Refusals carry a reason so the user always gets a short message instead of nothing.
 */
export function requestExtraCheckin(
  minutes: number,
  task: Pick<Task, "dueAt" | "scheduledStart">,
  settings: Pick<UserSettings, "quietStart" | "quietEnd">,
  tz: string,
  now: Date,
  dndUntil: Date | null,
  history: CheckinHistory[],
): ExtraRequest {
  const slot = task.scheduledStart?.getTime();
  const extras = history.filter((h) => h.kind === "COMPLETION_EXTRA" && h.status !== "CANCELLED" && h.slotStart.getTime() === slot).length;
  if (extras >= MAX_EXTRAS_PER_SLOT) return { ok: false, reason: "limit" };
  const fireAt = addMin(now, minutes);
  if (dndUntil && fireAt < dndUntil) return { ok: false, reason: "dnd" };
  if (isMuted(fireAt, settings, tz, null)) return { ok: false, reason: "quiet_hours" };
  return { ok: true, fireAt, passesDeadline: Boolean(task.dueAt && fireAt > task.dueAt) };
}

export function isCheckinTone(value: unknown): value is CheckinTone {
  return typeof value === "string" && (CHECKIN_TONES as readonly string[]).includes(value);
}

/**
 * Tone for one message: the saved style, except Gentle (no jokes, offer to split) when the latest
 * mood in the last 24 h is stressed/anxious/overwhelmed/sad. The saved style is never changed here.
 */
export function chooseTone(saved: string, latestMood: { mood: string; createdAt: Date } | null, now: Date): { tone: CheckinTone; offerSplit: boolean } {
  const base: CheckinTone = isCheckinTone(saved) ? saved : "FUNNY";
  const recent = latestMood && now.getTime() - latestMood.createdAt.getTime() <= 24 * 3600000 && latestMood.createdAt <= now;
  if (recent && GENTLE_MOODS.has(latestMood.mood)) return { tone: "GENTLE", offerSplit: true };
  return { tone: base, offerSplit: false };
}
