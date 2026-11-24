/**
 * A task's scheduled reminders on the phone are made from the server plan, so after a change they used to stay until
 * the next good sync: offline, a task marked done, deleted or moved kept firing its old reminders. The phone now
 * drops them at once (services/reminders.ts `cancelTaskReminders`); the next good sync re-makes what the server plans.
 * Only task reminders and task snoozes match. Check-ins (kind "lo-checkin"), routine reminders (no taskId) and
 * location alerts ("lo-loc:" identifiers) are left alone.
 */

type Scheduled = { identifier: string; content: { data?: unknown } };
type TaskTimes = { status: string; dueAt?: string | null; scheduledStart?: string | null; scheduledEnd?: string | null };

const CLOSED = new Set(["COMPLETED", "SKIPPED", "DELETED"]);

/** Identifiers of this task's scheduled reminders and snoozes ("lo:" notifications of kind "lo-reminder"). */
export function taskReminderIdentifiers(scheduled: Scheduled[], taskId: string, prefix = "lo:"): string[] {
  return scheduled
    .filter((n) => {
      const data = n.content.data as { kind?: unknown; taskId?: unknown } | null | undefined;
      return n.identifier.startsWith(prefix) && data?.kind === "lo-reminder" && data.taskId === taskId;
    })
    .map((n) => n.identifier);
}

function instant(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

type TaskFields = TaskTimes & { dueDate?: string | null; dueTime?: string | null };

/**
 * The calendar day of a stored `dueDate`. Two shapes exist for the same day: local midnight (the form's date picker,
 * in the phone's time zone) and exactly 12:00 UTC (the chat parser). UTC noon is read as its UTC date; anything else
 * as the date in `timeZone`, by default the phone's (the zone the form writes in, and the one `localDueAt` reads).
 */
export function calendarDay(iso: string | null | undefined, timeZone?: string): string | null {
  const t = instant(iso);
  if (t === null) return null;
  const d = new Date(t);
  if (d.getUTCHours() === 12 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0) return d.toISOString().slice(0, 10);
  if (timeZone) return d.toLocaleDateString("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "9:00 PM", "9 pm", "21:00" → minutes after midnight; null for no time or text that isn't a time. */
export function clockMinutes(time: string | null | undefined): number | null {
  const m = (time ?? "").trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return h * 60 + Number(m[2] ?? 0);
}

function minute(iso: string | null | undefined): number | null {
  const t = instant(iso);
  return t === null ? null : Math.floor(t / 60000);
}

/** The stored fields, normalised: a different calendar day, clock time, or planned start / end minute. */
export function fieldsMoved(before: TaskFields, after: TaskFields, timeZone?: string): boolean {
  return (
    calendarDay(before.dueDate, timeZone) !== calendarDay(after.dueDate, timeZone) ||
    clockMinutes(before.dueTime) !== clockMinutes(after.dueTime) ||
    minute(before.scheduledStart) !== minute(after.scheduledStart) ||
    minute(before.scheduledEnd) !== minute(after.scheduledEnd)
  );
}

/** The moments in time: a different deadline, planned start or planned end instant. */
export function momentsMoved(before: TaskTimes, after: TaskTimes): boolean {
  return (
    instant(before.dueAt) !== instant(after.dueAt) ||
    instant(before.scheduledStart) !== instant(after.scheduledStart) ||
    instant(before.scheduledEnd) !== instant(after.scheduledEnd)
  );
}

/**
 * Whether an edit makes the task's scheduled reminders wrong: it is now done, skipped or deleted, or it moved. A move
 * needs BOTH checks to agree (moments in time, and the normalised stored fields), so a save that keeps the same
 * time is not a move when the phone's and the settings' time zones differ, nor when a chat-made date (UTC noon) is
 * saved back from the form (local midnight). Other edits (title, priority, reminder mode…) leave the reminders.
 */
export function remindersOutdated(before: TaskFields, after: TaskFields, timeZone?: string): boolean {
  if (CLOSED.has(after.status) && !CLOSED.has(before.status)) return true;
  return momentsMoved(before, after) && fieldsMoved(before, after, timeZone);
}

/* ------------------------------------------------------------------ cancelled tasks (the race with a running sync) */

/** taskId → when its reminders were cancelled on the phone (ms). */
export type CancelledTasks = Record<string, number>;
export const CANCELLED_KEEP_MS = 7 * 86400000;

export type ClearContext = {
  now: number;
  /** When the request for the plan just fetched started (null: no plan fetched). */
  planRequestedAt: number | null;
  /** Task ids (and local ids) with a change still in the sync queue. */
  pending: Set<string>;
  /** Task ids on the phone; null when the list can't be read (keep the entries). */
  existing: Set<string> | null;
};

/**
 * Entries that can go: a plan was asked for after the cancel and the server has the change (nothing queued for the
 * task), so that plan is trusted; or 7 days passed (a stuck queue never switches reminders off for good); or the
 * task is no longer on the phone.
 */
export function cancelledToClear(all: CancelledTasks, ctx: ClearContext): string[] {
  return Object.entries(all)
    .filter(([id, at]) => {
      if (ctx.now - at >= CANCELLED_KEEP_MS) return true;
      if (ctx.existing && !ctx.existing.has(id)) return true;
      return ctx.planRequestedAt !== null && ctx.planRequestedAt > at && !ctx.pending.has(id);
    })
    .map(([id]) => id);
}

/** Task ids whose reminders a sync must not schedule: every entry that is not cleared. */
export function suppressedTasks(all: CancelledTasks, ctx: ClearContext): Set<string> {
  const clear = new Set(cancelledToClear(all, ctx));
  return new Set(Object.keys(all).filter((id) => !clear.has(id)));
}

/** Pending task ids from the sync queue (an offline create is named by its local id). */
export function pendingTaskIds(queue: Array<{ taskId?: string; localId?: string }>): Set<string> {
  const out = new Set<string>();
  for (const q of queue) {
    if (q.taskId) out.add(q.taskId);
    if (q.localId) out.add(q.localId);
  }
  return out;
}
