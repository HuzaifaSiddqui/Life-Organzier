import type { Task } from "../types/models";
import { ymdFromLocalDate } from "./datetimeValidation";

/**
 * CALENDAR_SYNC (docs/calendar.md): pure rules for the phone's "Life Organizer" calendar.
 * One-way write: the app's tasks and routine occurrences are the truth; the calendar mirrors them through an
 * eventId map (key → event). Each sync compares what should be there with the map, so create, edit, complete,
 * delete and undo all come down to create / update / delete, and an item never gets a second event.
 * Busy-time rules (clashes, free time) read the phone's other calendars; nothing from them leaves the phone.
 */

export const DEFAULT_EVENT_MINUTES = 30;
export const CALENDAR_TITLE = "Life Organizer";
/** Written in the notes of every event the app creates: only marked events are ever deleted on adoption. */
export const EVENT_MARKER = "Created by Life Organizer";

export const isOurEvent = (notes: string | null | undefined) => (notes ?? "").includes(EVENT_MARKER);
export const isOurTitle = (title: string) => title === CALENDAR_TITLE || /^Life Organizer \(\d+\)$/.test(title);

/** "Life Organizer", or "Life Organizer (2)", (3)… when a calendar already has the name. */
export function freeTitle(taken: string[]): string {
  if (!taken.includes(CALENDAR_TITLE)) return CALENDAR_TITLE;
  let n = 2;
  while (taken.includes(`${CALENDAR_TITLE} (${n})`)) n += 1;
  return `${CALENDAR_TITLE} (${n})`;
}
export const DONE_MARK = "✓ ";

export type EventSpec = { title: string; start: string; end: string; allDay: boolean };
export type MapEntry = { eventId: string; hash: string; start: string };
/** Keys: `t:<taskId>` and `r:<routineOccurrenceId>`. */
export type EventMap = Record<string, MapEntry>;
export type FeedOccurrence = { id: string; title: string; start: string; end: string; allDay: boolean; status: string };
export type Feed = { windowStart: string; windowEnd: string; occurrences: FeedOccurrence[] };

type TaskLike = Pick<Task, "id" | "title" | "status" | "dueDate" | "dueTime" | "dueAt" | "scheduledStart" | "scheduledEnd" | "durationMinutes" | "archived">;

const plus = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60000).toISOString();

/** Local midnight of a YYYY-MM-DD day, and of the next day (all-day events). */
function dayBounds(ymd: string): { start: string; end: string } {
  const [y, m, d] = ymd.split("-").map(Number);
  return { start: new Date(y, m - 1, d).toISOString(), end: new Date(y, m - 1, d + 1).toISOString() };
}

/**
 * A task's event: its work block when it has a scheduled start; else 30 minutes at the due time; else (date-only
 * deadline) an all-day event. No date, deleted or archived: no event. Completed: kept, marked ✓.
 */
export function taskEvent(task: TaskLike): EventSpec | null {
  if (task.status === "DELETED" || task.archived) return null;
  const title = (task.status === "COMPLETED" ? DONE_MARK : "") + task.title;
  if (task.scheduledStart) {
    const end = task.scheduledEnd ?? plus(task.scheduledStart, task.durationMinutes ?? DEFAULT_EVENT_MINUTES);
    return { title, start: task.scheduledStart, end, allDay: false };
  }
  if (!task.dueDate) return null;
  if (task.dueTime && task.dueAt) return { title, start: task.dueAt, end: plus(task.dueAt, DEFAULT_EVENT_MINUTES), allDay: false };
  return { title, ...dayBounds(ymdFromLocalDate(new Date(task.dueDate))), allDay: true };
}

export function occurrenceEvent(o: FeedOccurrence): EventSpec {
  const title = (o.status === "COMPLETED" ? DONE_MARK : "") + o.title;
  if (o.allDay) return { title, ...dayBounds(ymdFromLocalDate(new Date(o.start))), allDay: true };
  return { title, start: o.start, end: o.end, allDay: false };
}

const hashOf = (s: EventSpec) => JSON.stringify([s.title, s.start, s.end, s.allDay]);

/** What the calendar should hold now. `feed` null (offline, or the server didn't answer): routine events are left as they are. */
export function desiredEvents(tasks: TaskLike[], feed: Feed | null): Map<string, EventSpec> {
  const out = new Map<string, EventSpec>();
  for (const t of tasks) {
    const e = taskEvent(t);
    if (e) out.set(`t:${t.id}`, e);
  }
  for (const o of feed?.occurrences ?? []) out.set(`r:${o.id}`, occurrenceEvent(o));
  return out;
}

export type Op =
  | { kind: "create"; key: string; spec: EventSpec }
  | { kind: "update"; key: string; eventId: string; spec: EventSpec }
  | { kind: "delete"; key: string; eventId: string }
  /** Leave the event in the calendar but stop tracking it (a past routine occurrence: history stays). */
  | { kind: "forget"; key: string };

/**
 * The ops that make the calendar match `desired`. Tasks are all on the phone, so a task key that isn't desired is
 * deleted. Routine occurrences come in a window: one missing from the feed is deleted only when it falls inside
 * the window (routine deleted, paused or moved); one before the window is forgotten, never deleted.
 */
export function planOps(desired: Map<string, EventSpec>, map: EventMap, feed: Pick<Feed, "windowStart" | "windowEnd"> | null): Op[] {
  const ops: Op[] = [];
  for (const [key, spec] of desired) {
    const have = map[key];
    if (!have) ops.push({ kind: "create", key, spec });
    else if (have.hash !== hashOf(spec)) ops.push({ kind: "update", key, eventId: have.eventId, spec });
  }
  for (const [key, have] of Object.entries(map)) {
    if (desired.has(key)) continue;
    if (key.startsWith("t:")) ops.push({ kind: "delete", key, eventId: have.eventId });
    else if (feed) {
      const start = Date.parse(have.start);
      if (start < Date.parse(feed.windowStart)) ops.push({ kind: "forget", key });
      else if (start < Date.parse(feed.windowEnd)) ops.push({ kind: "delete", key, eventId: have.eventId });
    }
  }
  return ops;
}

/** The calendar operations sync needs (expo-calendar behind it; tests pass a fake). */
export type CalendarPort = {
  createEvent(spec: EventSpec): Promise<string>;
  /** Throws when the event is gone (deleted in the calendar app). */
  updateEvent(eventId: string, spec: EventSpec): Promise<void>;
  deleteEvent(eventId: string): Promise<void>;
};

/**
 * Applies ops one by one and returns the new map. An event the user deleted in the calendar app is created again on
 * its next change; a failed create is retried by the next sync (no map entry = not there). Deletes that fail are
 * dropped from the map anyway, so they can't block anything.
 */
export async function applyOps(port: CalendarPort, ops: Op[], map: EventMap): Promise<{ map: EventMap; failed: number }> {
  const next: EventMap = { ...map };
  let failed = 0;
  for (const op of ops) {
    try {
      if (op.kind === "create") {
        next[op.key] = { eventId: await port.createEvent(op.spec), hash: hashOf(op.spec), start: op.spec.start };
      } else if (op.kind === "update") {
        try {
          await port.updateEvent(op.eventId, op.spec);
          next[op.key] = { eventId: op.eventId, hash: hashOf(op.spec), start: op.spec.start };
        } catch {
          next[op.key] = { eventId: await port.createEvent(op.spec), hash: hashOf(op.spec), start: op.spec.start };
        }
      } else if (op.kind === "delete") {
        delete next[op.key];
        await port.deleteEvent(op.eventId).catch(() => undefined);
      } else {
        delete next[op.key];
      }
    } catch {
      failed += 1;
    }
  }
  return { map: next, failed };
}

type EventDetails = { title: string; startDate: Date; endDate: Date; allDay: boolean; timeZone: string; notes: string };
type ExpoLikeEvent = { update(details: Partial<EventDetails>): Promise<void>; delete(): Promise<void> };
type ExpoLikeCalendar = { createEvent(details: EventDetails): Promise<{ id: string }> };

/**
 * CalendarPort over expo-calendar's object API (an ExpoCalendar and ExpoCalendarEvent.get). `allDayUtc`: Android
 * stores all-day events at UTC midnight in the UTC zone, so the local day is moved there.
 */
export function expoPort(cal: ExpoLikeCalendar, getEvent: (id: string) => Promise<ExpoLikeEvent>, opts: { timeZone: string; allDayUtc: boolean }): CalendarPort {
  const details = (s: EventSpec): EventDetails => {
    if (s.allDay && opts.allDayUtc) {
      const d = new Date(s.start);
      const start = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      return { title: s.title, startDate: start, endDate: new Date(start.getTime() + 86400000), allDay: true, timeZone: "UTC", notes: EVENT_MARKER };
    }
    return { title: s.title, startDate: new Date(s.start), endDate: new Date(s.end), allDay: s.allDay, timeZone: opts.timeZone, notes: EVENT_MARKER };
  };
  return {
    createEvent: async (s) => (await cal.createEvent(details(s))).id,
    updateEvent: async (id, s) => (await getEvent(id)).update(details(s)),
    deleteEvent: async (id) => (await getEvent(id)).delete(),
  };
}

/* ------------------------------------------------------------------ busy time (stays on the phone) */

export type BusyEvent = { title: string; start: number; end: number; allDay: boolean; free?: boolean };

/** Timed events that overlap [start, end). All-day events and events marked "free" never clash. */
export function clashesWith(busy: BusyEvent[], start: number, end: number): BusyEvent[] {
  return busy.filter((b) => !b.allDay && !b.free && b.start < end && start < b.end).sort((a, b) => a.start - b.start);
}

/** The time span a task would take in the calendar (null: nothing to check, e.g. no time). */
export function taskSpan(task: Pick<TaskLike, "scheduledStart" | "scheduledEnd" | "durationMinutes" | "dueDate" | "dueTime" | "dueAt">): { start: number; end: number } | null {
  const e = taskEvent({ ...task, id: "", title: "", status: "PENDING", archived: false });
  if (!e || e.allDay) return null;
  return { start: Date.parse(e.start), end: Date.parse(e.end) };
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
