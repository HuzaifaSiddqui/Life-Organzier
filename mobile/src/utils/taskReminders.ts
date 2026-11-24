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

/**
 * Whether an edit makes the task's scheduled reminders wrong: it is now done, skipped or deleted, or it moved (its
 * deadline, planned start or planned end is a different instant). Other edits (title, priority, reminder mode…)
 * leave the reminders until the next sync. Instants are compared, not strings, so a form save that keeps the same
 * time in another format is not a move.
 */
export function remindersOutdated(before: TaskTimes, after: TaskTimes): boolean {
  if (CLOSED.has(after.status) && !CLOSED.has(before.status)) return true;
  return (
    instant(before.dueAt) !== instant(after.dueAt) ||
    instant(before.scheduledStart) !== instant(after.scheduledStart) ||
    instant(before.scheduledEnd) !== instant(after.scheduledEnd)
  );
}
