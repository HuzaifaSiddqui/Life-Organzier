import type { Task } from "../types/models";
import { isOverdue } from "./format";
import { addDays, startOfDay } from "./timeline";

/**
 * Tasks tab (UI v3): smart views and date groups. Pure, tested in __tests__/taskViews.test.ts.
 * A task's date is its planned start, else its due time, else its due date; none = "No date".
 */

export type TaskView = "ALL" | "TODAY" | "UPCOMING" | "NODATE" | "OVERDUE" | "DONE";
export type GroupKey = "overdue" | "today" | "tomorrow" | "week" | "later" | "nodate" | "done";

export function taskTime(t: Task): number | null {
  const iso = t.scheduledStart ?? t.dueAt ?? t.dueDate;
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

const visible = (t: Task) => t.status !== "DELETED" && !t.archived;
const open = (t: Task) => t.status !== "COMPLETED";

export function groupOf(t: Task, now = new Date()): GroupKey {
  if (!open(t)) return "done";
  if (isOverdue(t, now)) return "overdue";
  const at = taskTime(t);
  if (at === null) return "nodate";
  const today = startOfDay(now).getTime();
  const day = 86400000;
  if (at < today + day) return "today";
  if (at < today + 2 * day) return "tomorrow";
  if (at < addDays(startOfDay(now), 7).getTime()) return "week";
  return "later";
}

export function inView(t: Task, view: TaskView, now = new Date()): boolean {
  if (!visible(t)) return false;
  const g = groupOf(t, now);
  switch (view) {
    case "ALL":
      return g !== "done";
    case "TODAY":
      return g === "today" || g === "overdue";
    case "UPCOMING":
      return g === "tomorrow" || g === "week" || g === "later";
    case "NODATE":
      return g === "nodate";
    case "OVERDUE":
      return g === "overdue";
    case "DONE":
      return g === "done";
  }
}

export function viewCounts(tasks: Task[], now = new Date()): Record<TaskView, number> {
  const views: TaskView[] = ["ALL", "TODAY", "UPCOMING", "NODATE", "OVERDUE", "DONE"];
  const top = tasks.filter((t) => !t.parentTaskId);
  return Object.fromEntries(views.map((v) => [v, top.filter((t) => inView(t, v, now)).length])) as Record<TaskView, number>;
}

const ORDER: GroupKey[] = ["overdue", "today", "tomorrow", "week", "later", "nodate", "done"];

/** Sections in reading order, empty ones left out; `sort` orders inside each section. */
export function groupTasks(tasks: Task[], now: Date, sort: (a: Task, b: Task) => number): Array<{ key: GroupKey; tasks: Task[] }> {
  const by = new Map<GroupKey, Task[]>();
  for (const t of tasks) {
    const g = groupOf(t, now);
    by.set(g, [...(by.get(g) ?? []), t]);
  }
  return ORDER.filter((k) => by.has(k)).map((k) => ({ key: k, tasks: [...(by.get(k) as Task[])].sort(sort) }));
}
