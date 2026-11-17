import type { Routine, RoutineOccurrence, Task } from "../types/models";

/**
 * Plan timeline (docs/design.md "Plan"): pure rules, tested in __tests__/timeline.test.ts.
 * - Which tasks and routine occurrences fall on a local day, where they sit in minutes, and which have no time.
 * - Overlapping items side by side (columns), like a calendar.
 * - Dragging snaps to 15 minutes; what a move changes (planned start, due time, or the routine occurrence).
 */

export const DAY_MINUTES = 1440;
export const SNAP = 15;
const DEFAULT_MINUTES = 30;
const MIN_MINUTES = 15;

export type TimelineAnchor = "scheduled" | "due" | "routine";

export type TimelineItem = {
  key: string;
  kind: "task" | "routine";
  /** Task id, or the routine occurrence id. */
  id: string;
  routineId?: string;
  title: string;
  /** Minutes from the start of the day. */
  start: number;
  end: number;
  anchor: TimelineAnchor;
  done: boolean;
  /** Skipped routine, or a deleted/archived task: shown faded. */
  muted: boolean;
  overdue: boolean;
  priority: string;
  category: string | null;
  /** A task due at this minute (its deadline), not a block of planned time. */
  deadline: boolean;
  /** A time-locked routine: moving one occurrence asks first. */
  locked?: boolean;
};

export type DayPlan = { timed: TimelineItem[]; allDay: TimelineItem[] };

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Local YYYY-MM-DD. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function minutesOf(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** "HH:mm" (24 h) or "h:mm am/pm" → minutes; null when there's no time. */
export function parseClock(text: string | null | undefined): number | null {
  const m = (text ?? "").trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  const min = Number(m[2] ?? 0);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function clockText(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const closed = (t: Task) => t.status === "DELETED" || Boolean(t.archived);
const isDone = (t: Task) => t.status === "COMPLETED";

function block(start: number, minutes: number | null | undefined): { start: number; end: number } {
  const s = Math.max(0, Math.min(DAY_MINUTES - MIN_MINUTES, start));
  return { start: s, end: Math.min(DAY_MINUTES, s + Math.max(MIN_MINUTES, minutes || DEFAULT_MINUTES)) };
}

/** Tasks and routine occurrences on one local day: timed blocks and the day's untimed items. */
export function itemsForDay(tasks: Task[], routines: Routine[], day: Date, now = new Date()): DayPlan {
  const timed: TimelineItem[] = [];
  const allDay: TimelineItem[] = [];
  for (const t of tasks) {
    if (closed(t)) continue;
    const base = { kind: "task" as const, id: t.id, title: t.title, done: isDone(t), muted: false, priority: t.priority, category: t.category ?? null };
    const overdue = !isDone(t) && Boolean(t.dueAt) && new Date(t.dueAt as string) < now;
    if (t.scheduledStart) {
      const s = new Date(t.scheduledStart);
      if (!sameDay(s, day)) continue;
      const e = t.scheduledEnd ? new Date(t.scheduledEnd) : null;
      const minutes = e && e > s ? Math.round((e.getTime() - s.getTime()) / 60000) : t.durationMinutes;
      timed.push({ ...base, key: `t:${t.id}`, ...block(minutesOf(s), minutes), anchor: "scheduled", overdue, deadline: false });
      continue;
    }
    if (!t.dueAt) continue;
    const due = new Date(t.dueAt);
    if (!sameDay(due, day)) continue;
    if (parseClock(t.dueTime) === null) {
      allDay.push({ ...base, key: `t:${t.id}`, start: 0, end: 0, anchor: "due", overdue, deadline: true });
      continue;
    }
    timed.push({ ...base, key: `t:${t.id}`, ...block(minutesOf(due), t.durationMinutes), anchor: "due", overdue, deadline: true });
  }
  for (const r of routines) {
    if (!r.active) continue;
    for (const o of r.occurrences ?? []) {
      if (!sameDay(new Date(o.occurrenceDate), day)) continue;
      const item = routineItem(r, o);
      const time = parseClock(o.dueTime ?? r.dueTime);
      if (time === null) allDay.push(item);
      else timed.push({ ...item, ...block(time, r.durationMinutes) });
    }
  }
  timed.sort((a, b) => a.start - b.start || b.end - a.end);
  return { timed, allDay };
}

function routineItem(r: Routine, o: RoutineOccurrence): TimelineItem {
  return {
    key: `r:${o.id}`,
    kind: "routine",
    id: o.id,
    routineId: r.id,
    title: r.title,
    start: 0,
    end: 0,
    anchor: "routine",
    done: o.status === "COMPLETED",
    muted: o.status === "SKIPPED",
    overdue: false,
    priority: r.priority,
    category: r.category,
    deadline: false,
    locked: r.timeLocked,
  };
}

export type Placed = TimelineItem & { col: number; cols: number };

/** Overlapping items side by side: each cluster of overlaps shares its width; an item takes the first free column. */
export function layoutColumns(items: TimelineItem[]): Placed[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Placed[] = [];
  let cluster: Placed[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((p) => p.col + 1));
    for (const p of cluster) out.push({ ...p, cols });
    cluster = [];
  };
  for (const item of sorted) {
    if (cluster.length && item.start >= clusterEnd) flush();
    const taken = new Set(cluster.filter((p) => p.end > item.start).map((p) => p.col));
    let col = 0;
    while (taken.has(col)) col += 1;
    cluster.push({ ...item, col, cols: 1 });
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  if (cluster.length) flush();
  return out;
}

/** A drag position in minutes, snapped to 15 and kept inside the day. */
export function snapMinutes(minutes: number, length = MIN_MINUTES, step = SNAP): number {
  const snapped = Math.round(minutes / step) * step;
  return Math.max(0, Math.min(DAY_MINUTES - Math.max(step, length), snapped));
}

/** A tap on an empty slot: the start it suggests (snapped down to the half hour). */
export function slotStart(minutes: number): number {
  return Math.max(0, Math.min(DAY_MINUTES - 30, Math.floor(minutes / 30) * 30));
}

export type MoveChange =
  | { kind: "task"; id: string; changes: { scheduledStart: string; scheduledEnd: string } | { dueDate: string; dueTime: string } }
  | { kind: "routine"; id: string; date: string; time: string };

/** What moving (or resizing) an item to `start`–`end` on `day` saves. */
export function moveChange(item: TimelineItem, day: Date, start: number, end: number): MoveChange {
  if (item.kind === "routine") return { kind: "routine", id: item.id, date: dayKey(day), time: clockText(start) };
  if (item.anchor === "scheduled") {
    const at = (m: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, m).toISOString();
    return { kind: "task", id: item.id, changes: { scheduledStart: at(start), scheduledEnd: at(end) } };
  }
  return { kind: "task", id: item.id, changes: { dueDate: dayKey(day), dueTime: clockText(start) } };
}

/** The 7 days of the week containing `d` (Monday first, as in Pakistan and most of the world). */
export function weekOf(d: Date, weekStartsOn = 1): Date[] {
  const s = startOfDay(d);
  const back = (s.getDay() - weekStartsOn + 7) % 7;
  return Array.from({ length: 7 }, (_, i) => addDays(s, i - back));
}

/** A month as 6 rows of 7 days (with the neighbouring months' days to fill the grid). */
export function monthGrid(month: Date, weekStartsOn = 1): Date[][] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = weekOf(first, weekStartsOn)[0];
  return Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, i) => addDays(start, w * 7 + i)));
}

/** How many open items each day has (month view dots), keyed by dayKey. */
export function countByDay(tasks: Task[], routines: Routine[], days: Date[], now = new Date()): Record<string, { open: number; done: number; overdue: number }> {
  const out: Record<string, { open: number; done: number; overdue: number }> = {};
  for (const d of days) {
    const { timed, allDay } = itemsForDay(tasks, routines, d, now);
    const all = [...timed, ...allDay].filter((i) => !i.muted);
    out[dayKey(d)] = { open: all.filter((i) => !i.done).length, done: all.filter((i) => i.done).length, overdue: all.filter((i) => i.overdue).length };
  }
  return out;
}

/** Free time between items from `from` to `to` minutes (gaps of at least 30 min), for "free" hints. */
export function freeGaps(items: TimelineItem[], from: number, to: number, min = 30): Array<{ start: number; end: number }> {
  const busy = items.filter((i) => !i.muted && !i.done).sort((a, b) => a.start - b.start);
  const gaps: Array<{ start: number; end: number }> = [];
  let cursor = from;
  for (const i of busy) {
    if (i.start - cursor >= min) gaps.push({ start: cursor, end: Math.min(i.start, to) });
    cursor = Math.max(cursor, i.end);
    if (cursor >= to) break;
  }
  if (to - cursor >= min) gaps.push({ start: cursor, end: to });
  return gaps.filter((g) => g.end - g.start >= min);
}
