import type { Task } from "../types/models";
import {
  clearTaskReminder,
  type ReminderResult,
  type TaskReminderHint,
  upsertTaskReminder,
} from "./reminders";
import { createTask } from "./tasksApi";

/** POST /tasks body shape (same as {@link createTask}). */
export type CreateTaskApiPayload = Parameters<typeof createTask>[0];

export type CreateTaskReminderOptions =
  | { reminderEnabled: true; reminderHint: TaskReminderHint }
  | { reminderEnabled: false };

/**
 * Single path for creating a task and scheduling (or skipping) its local reminder.
 * Manual, chat, and voice flows must use this so reminder behavior cannot diverge.
 */
export async function createTaskWithReminder(
  apiPayload: CreateTaskApiPayload,
  options: CreateTaskReminderOptions,
): Promise<{ task: Task; reminder: ReminderResult }> {
  const task = await createTask(apiPayload);

  if (options.reminderEnabled) {
    const reminder = await upsertTaskReminder(task, options.reminderHint);
    return { task, reminder };
  }

  await clearTaskReminder(task.id);
  return { task, reminder: { kind: "cleared" } };
}
