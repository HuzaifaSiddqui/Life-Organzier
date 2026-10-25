/**
 * "Snooze 15 min" on a task reminder schedules the same notification again in 15 minutes. Every re-sync cancels all
 * of the app's notifications and re-makes them from the server plan, which knew nothing of the snooze, so the copy
 * was lost. The phone now keeps its snoozes and each sync schedules them again (same identifier, same time) until
 * they fire, or the task is no longer open.
 */
export const TASK_SNOOZE_MINUTES = 15;

export type TaskSnooze = {
  /** Notification identifier: the same one on every re-sync, so a copy replaces itself. */
  identifier: string;
  taskId: string;
  fireAt: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  categoryIdentifier: string | null;
};

export function addTaskSnooze(list: TaskSnooze[], s: Omit<TaskSnooze, "identifier" | "fireAt">, now: number): TaskSnooze[] {
  const fireAt = new Date(now + TASK_SNOOZE_MINUTES * 60000).toISOString();
  // One snooze per task: snoozing again replaces the earlier one.
  return [...list.filter((x) => x.taskId !== s.taskId), { ...s, identifier: `snooze:t:${s.taskId}`, fireAt }];
}

/**
 * The snoozes a sync at `now` schedules again: not yet fired, and the task still open on the phone (`open` is
 * null when the local task list can't be read: keep them rather than lose one).
 */
export function liveTaskSnoozes(list: TaskSnooze[], open: Set<string> | null, now: number): TaskSnooze[] {
  return list.filter((s) => new Date(s.fireAt).getTime() > now && (!open || open.has(s.taskId)));
}

export function withoutTask(list: TaskSnooze[], taskId: string): TaskSnooze[] {
  return list.filter((s) => s.taskId !== taskId);
}
