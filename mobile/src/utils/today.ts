import type { AttentionItem, Routine, Task } from "../types/models";
import { itemsForDay, minutesOf, startOfDay, type TimelineItem } from "./timeline";

/**
 * Today screen (UI v3): the day's agenda from the same rules as Plan (utils/timeline.ts), split around "now", and the
 * honest counts for the header. Tested in __tests__/today.test.ts.
 */

export type Agenda = {
  /** Timed items that started before now (done or not). */
  earlier: TimelineItem[];
  /** Timed items from now on. */
  later: TimelineItem[];
  /** The day's items without a time. */
  anyTime: TimelineItem[];
  total: number;
  done: number;
  left: number;
  /** Open tasks due on earlier days (not part of today's counts). */
  overdueBefore: number;
  /** Minutes of open timed work left today. */
  plannedMinutes: number;
};

export function todayAgenda(tasks: Task[], routines: Routine[], now = new Date()): Agenda {
  const { timed, allDay } = itemsForDay(tasks, routines, now, now);
  const live = (i: TimelineItem) => !i.muted;
  const nowMin = minutesOf(now);
  const earlier = timed.filter((i) => live(i) && i.start < nowMin);
  const later = timed.filter((i) => live(i) && i.start >= nowMin);
  const anyTime = allDay.filter(live);
  const all = [...earlier, ...later, ...anyTime];
  const done = all.filter((i) => i.done).length;
  const startToday = startOfDay(now).getTime();
  const overdueBefore = tasks.filter((t) => t.status !== "COMPLETED" && t.status !== "DELETED" && !t.archived && t.dueAt && new Date(t.dueAt).getTime() < startToday).length;
  const plannedMinutes = [...earlier, ...later].filter((i) => !i.done && i.end > nowMin).reduce((sum, i) => sum + (i.end - Math.max(i.start, nowMin)), 0);
  return { earlier, later, anyTime, total: all.length, done, left: all.length - done, overdueBefore, plannedMinutes };
}

/** "yasir imran" → "Yasir" (first name, capitalised) for the greeting. */
export function firstName(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0];
  if (!first) return null;
  return first.charAt(0).toLocaleUpperCase() + first.slice(1);
}

export type DayPart = "morning" | "afternoon" | "evening";

export function dayPart(now = new Date()): DayPart {
  const h = now.getHours();
  return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
}

/**
 * The decisions worth a card on Today (UI v3), most urgent first. Left out: missed fixed-time routines (an FYI: the next
 * one is already planned) and overdue tasks (one Catch up card covers them all). `dismissed`: "Not now" this session.
 */
const HIDDEN_KINDS = new Set(["missed_routine_locked", "overdue_deadline"]);
const SEVERITY = { critical: 0, warning: 1, info: 2 } as const;

export function nudgesFrom(attention: AttentionItem[], dismissed: ReadonlySet<string> = new Set()): AttentionItem[] {
  return attention.filter((a) => !HIDDEN_KINDS.has(a.kind) && !dismissed.has(a.id)).sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]);
}

/** Icon and tone for a nudge's card. */
export function nudgeLook(kind: string): { icon: "pulse" | "layers" | "sparkle" | "repeat" | "calendar" | "clock" | "info"; tone: "danger" | "warning" | "info" | "accent" } {
  switch (kind) {
    case "overloaded_day":
      return { icon: "clock", tone: "warning" };
    case "very_stressed":
      return { icon: "pulse", tone: "warning" };
    case "stress_big_task":
      return { icon: "layers", tone: "warning" };
    case "stuck":
      return { icon: "sparkle", tone: "accent" };
    case "missed_routine_flexible":
      return { icon: "repeat", tone: "info" };
    case "missed_fixed":
      return { icon: "calendar", tone: "info" };
    default:
      return { icon: "info", tone: "info" };
  }
}
