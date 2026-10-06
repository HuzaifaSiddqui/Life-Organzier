import type { Task } from "../types/models";

export const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function isOverdue(task: Task, now = new Date()): boolean {
  if (typeof task.isOverdue === "boolean" && !task.pendingSync) return task.isOverdue;
  if (task.status === "COMPLETED" || task.status === "DELETED" || task.status === "SKIPPED" || task.archived) return false;
  return Boolean(task.dueAt && Date.parse(task.dueAt) < now.getTime());
}

function dayLabel(d: Date, now = new Date()): string {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((that - start) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function formatDue(task: Task): string {
  if (task.scheduledStart && task.status !== "COMPLETED") {
    const s = new Date(task.scheduledStart);
    return `${dayLabel(s)} ${formatTime(task.scheduledStart)}${task.scheduledEnd ? `–${formatTime(task.scheduledEnd)}` : ""}`;
  }
  const iso = task.dueAt ?? task.dueDate;
  if (!iso) return "No due date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "No due date";
  return task.dueTime ? `Due ${dayLabel(d)} ${task.dueTime}` : `Due ${dayLabel(d)}`;
}

export function formatDuration(minutes: number | null | undefined): string {
  if (!minutes) return "";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h} hour${h === 1 ? "" : "s"}`;
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
