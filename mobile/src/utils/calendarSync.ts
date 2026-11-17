import type { Task } from "../types/models";
import type { TaskInput } from "../services/tasksApi";
import { ymdFromLocalDate } from "./datetimeValidation";

/**
 * CALENDAR_SYNC (docs/calendar.md): pure rules for the phone's calendar. One-way: the phone's calendar → the app.
 * Upcoming events (IMPORT_DAYS ahead) are offered as tasks; the user adds or skips each one, and nothing is ever
 * written to the calendar. Earlier versions wrote tasks into the calendar with EVENT_MARKER in the notes; those
 * marked events are removed once (services/calendar.ts) and never offered for import.
 * Busy-time rules (clashes, free time) read the phone's calendars; nothing from them leaves the phone.
 */

export const DEFAULT_EVENT_MINUTES = 30;
export const CALENDAR_TITLE = "Life Organizer";
/** In the notes of every event older versions wrote: only marked events are deleted by the clean-up. */
export const EVENT_MARKER = "Created by Life Organizer";
/** Days ahead of now that events are offered for import. */
export const IMPORT_DAYS = 30;

export const isOurEvent = (notes: string | null | undefined) => (notes ?? "").includes(EVENT_MARKER);
export const isOurTitle = (title: string) => title === CALENDAR_TITLE || /^Life Organizer \(\d+\)$/.test(title);

type TaskLike = Pick<Task, "id" | "title" | "status" | "dueDate" | "dueTime" | "dueAt" | "scheduledStart" | "scheduledEnd" | "durationMinutes" | "archived">;

const plus = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60000).toISOString();

/* ------------------------------------------------------------------ import (calendar → app) */

/** An event as read from the phone (expo-calendar's shape, only what's used). */
export type PhoneEvent = {
  id: string;
  title?: string | null;
  startDate: string | Date;
  endDate: string | Date;
  allDay?: boolean | null;
  notes?: string | null;
  location?: string | null;
};

/** An event offered as a task. `key` is the event id plus its start, so each instance of a repeating event is its own. */
export type ImportCandidate = { key: string; title: string; start: string; end: string; allDay: boolean; location: string | null };

/** Keys the user already added or skipped, with the event's start (ms) so old ones can be forgotten. */
export type Decided = Record<string, number>;

const iso = (d: string | Date) => new Date(d).toISOString();
export const eventKey = (e: Pick<PhoneEvent, "id" | "startDate">) => `${e.id}@${iso(e.startDate)}`;
const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The local day of an event start (all-day events are stored at UTC midnight on Android, `allDayUtc`). */
export function eventYmd(c: Pick<ImportCandidate, "start" | "allDay">, allDayUtc = false): string {
  const d = new Date(c.start);
  return c.allDay && allDayUtc ? d.toISOString().slice(0, 10) : ymdFromLocalDate(d);
}

/** True when the app already has this task: same title and the same start minute (timed) or the same day (all-day). */
function alreadyATask(c: ImportCandidate, tasks: TaskLike[], allDayUtc: boolean): boolean {
  return tasks.some((t) => {
    if (t.status === "DELETED" || t.archived || !sameTitle(t.title, c.title)) return false;
    if (c.allDay) return Boolean(t.dueDate) && ymdFromLocalDate(new Date(t.dueDate!)) === eventYmd(c, allDayUtc);
    const start = t.scheduledStart ?? t.dueAt;
    return Boolean(start) && Math.abs(Date.parse(start!) - Date.parse(c.start)) < 60000;
  });
}

/**
 * Events to offer: not ended yet, not written by older versions of the app, not added or skipped before, and not
 * already a task. Sorted by start; one per key.
 */
export function importCandidates(events: PhoneEvent[], decided: Decided, tasks: TaskLike[], now: number, opts: { allDayUtc?: boolean } = {}): ImportCandidate[] {
  const seen = new Set<string>();
  const out: ImportCandidate[] = [];
  for (const e of events) {
    if (isOurEvent(e.notes)) continue;
    const key = eventKey(e);
    if (seen.has(key) || key in decided) continue;
    seen.add(key);
    const end = Date.parse(iso(e.endDate));
    if (!(end > now)) continue;
    const c: ImportCandidate = { key, title: (e.title ?? "").trim(), start: iso(e.startDate), end: iso(e.endDate), allDay: Boolean(e.allDay), location: e.location?.trim() || null };
    if (!c.title || alreadyATask(c, tasks, Boolean(opts.allDayUtc))) continue;
    out.push(c);
  }
  return out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.title.localeCompare(b.title));
}

/** Decisions for events that started more than a day ago are dropped (they can't be offered again). */
export function pruneDecided(decided: Decided, now: number): Decided {
  return Object.fromEntries(Object.entries(decided).filter(([, start]) => start > now - 86400000));
}

/** "3:00 PM" for a local time (the app's due-time format). */
function clock12(d: Date): string {
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * The task for an event: timed → due on its day at its start time, planned for its span (FIXED); all-day → due that
 * day (multi-day events: the first day). The note says where it came from.
 */
export function taskFromEvent(c: ImportCandidate, note: string, allDayUtc = false): TaskInput {
  const ymd = eventYmd(c, allDayUtc);
  const dueDate = new Date(`${ymd}T00:00:00`).toISOString();
  const description = [note, c.location].filter(Boolean).join("\n");
  if (c.allDay) return { title: c.title, description, dueDate, dueTime: null, priority: "MEDIUM", taskType: "DEADLINE", source: "MANUAL" };
  const start = new Date(c.start);
  const minutes = Math.max(5, Math.round((Date.parse(c.end) - Date.parse(c.start)) / 60000));
  return {
    title: c.title,
    description,
    dueDate,
    dueTime: clock12(start),
    priority: "MEDIUM",
    taskType: "FIXED",
    durationMinutes: minutes,
    scheduledStart: c.start,
    scheduledEnd: c.end,
    source: "MANUAL",
  };
}

/* ------------------------------------------------------------------ busy time (stays on the phone) */

export type BusyEvent = { title: string; start: number; end: number; allDay: boolean; free?: boolean };

/** Timed events that overlap [start, end). All-day events and events marked "free" never clash. */
export function clashesWith(busy: BusyEvent[], start: number, end: number): BusyEvent[] {
  return busy.filter((b) => !b.allDay && !b.free && b.start < end && start < b.end).sort((a, b) => a.start - b.start);
}

/**
 * The time span a task takes: its work block when it has a scheduled start; else 30 minutes at the due time.
 * Null when there's nothing to check (no time, date-only deadline).
 */
export function taskSpan(task: Pick<TaskLike, "scheduledStart" | "scheduledEnd" | "durationMinutes" | "dueDate" | "dueTime" | "dueAt">): { start: number; end: number } | null {
  if (task.scheduledStart) {
    const end = task.scheduledEnd ?? plus(task.scheduledStart, task.durationMinutes ?? DEFAULT_EVENT_MINUTES);
    return { start: Date.parse(task.scheduledStart), end: Date.parse(end) };
  }
  if (!task.dueDate || !task.dueTime || !task.dueAt) return null;
  return { start: Date.parse(task.dueAt), end: Date.parse(plus(task.dueAt, DEFAULT_EVENT_MINUTES)) };
}

/** Free gaps of at least `minMinutes` between `from` and `to` (day hours), around timed busy events. */
export function freeSlots(busy: BusyEvent[], from: number, to: number, minMinutes = 30): Array<{ start: number; end: number }> {
  const blocks = busy.filter((b) => !b.allDay && !b.free && b.end > from && b.start < to).sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; end: number }> = [];
  let cursor = from;
  for (const b of blocks) {
    if (b.start - cursor >= minMinutes * 60000) out.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (to - cursor >= minMinutes * 60000) out.push({ start: cursor, end: to });
  return out;
}

/** "HH:MM" (24 h) on a local day → epoch ms. */
export function atClock(ymd: string, hhmm: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  const [h, min] = hhmm.split(":").map(Number);
  return new Date(y, m - 1, d, h || 0, min || 0).getTime();
}
