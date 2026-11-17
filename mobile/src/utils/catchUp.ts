import type { TaskChanges } from "../services/tasksApi";
import type { Task } from "../types/models";
import { isOverdue } from "./format";
import { addDays, dayKey, minutesOf, parseClock, startOfDay } from "./timeline";

/**
 * Catch up (UI v3): sorting overdue tasks one by one. What each choice changes; pure, tested in
 * __tests__/catchUp.test.ts.
 * - Today: today's date; the old time stays if it's still ahead today, else "any time today" (no time).
 * - Tomorrow / Next week (next Monday) / a picked date: that date, the old time kept.
 * - A stale planned block (scheduledStart / End) is cleared: it was for the old day.
 * Done and Drop are status changes (done / delete), not handled here.
 */

export type CatchUpMove = "today" | "tomorrow" | "nextWeek" | { ymd: string };

/** Overdue tasks to sort, oldest first (top-level only; steps follow their parent). */
export function catchUpQueue(tasks: Task[], now = new Date()): Task[] {
  return tasks
    .filter((t) => !t.parentTaskId && isOverdue(t, now))
    .sort((a, b) => Date.parse(a.dueAt ?? a.dueDate ?? "") - Date.parse(b.dueAt ?? b.dueDate ?? ""));
}

export function moveDate(move: CatchUpMove, now = new Date()): string {
  const today = startOfDay(now);
  if (move === "today") return dayKey(today);
  if (move === "tomorrow") return dayKey(addDays(today, 1));
  if (move === "nextWeek") {
    const toMon = ((8 - today.getDay()) % 7) || 7;
    return dayKey(addDays(today, toMon));
  }
  return move.ymd;
}

export function catchUpChange(task: Task, move: CatchUpMove, now = new Date()): TaskChanges {
  const ymd = moveDate(move, now);
  const time = parseClock(task.dueTime);
  const keepTime = time !== null && !(move === "today" && time <= minutesOf(now));
  const changes: TaskChanges = { dueDate: ymd, dueTime: keepTime ? task.dueTime : null };
  if (task.scheduledStart || task.scheduledEnd) {
    changes.scheduledStart = null;
    changes.scheduledEnd = null;
  }
  return changes;
}
