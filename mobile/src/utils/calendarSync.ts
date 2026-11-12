import type { Task } from "../types/models";
import { formatDueTime12h, ymdFromLocalDate } from "./datetimeValidation";

/**
 * CALENDAR_SYNC (docs/calendar.md): pure rules for the phone's "Life Organizer" calendar.
 * The app's tasks and routine occurrences are written to the calendar through an eventId map (key → event). Each sync
 * compares what should be there with the map, so create, edit, complete, delete and undo all come down to create /
 * update / delete, and an item never gets a second event.
 * Two-way for the app's own task events only (pullChanges): a time moved, a title changed, "✓" added or the event
 * deleted in the calendar app is brought back to the task on the next sync. Routine events stay one-way.
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
/** `detached`: the user deleted the event in the calendar; the task is kept and no event is made again until the task changes. */
export type MapEntry = { eventId: string; hash: string; start: string; detached?: boolean };
/** Keys: `t:<taskId>` and `r:<routineOccurrenceId>`. */
export type EventMap = Record<string, MapEntry>;
export type FeedOccurrence = { id: string; title: string; start: string; end: string; allDay: boolean; status: string };
export type Feed = { windowStart: string; windowEnd: string; occurrences: FeedOccurrence[] };

type TaskLike = Pick<Task, "id" | "title" | "status" | "dueDate" | "dueTime" | "dueAt" | "scheduledStart" | "scheduledEnd" | "durationMinutes" | "archived">;
type TaskWithTime = TaskLike & Pick<Task, "updatedAt">;

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

export const hashOf = (s: EventSpec) => JSON.stringify([s.title, s.start, s.end, s.allDay]);

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
    // Deleted in the calendar: stays gone until the task itself changes (then it's added back).
    if (have?.detached) {
      if (have.hash !== hashOf(spec)) ops.push({ kind: "create", key, spec });
      continue;
    }
    if (!have) ops.push({ kind: "create", key, spec });
    else if (have.hash !== hashOf(spec)) ops.push({ kind: "update", key, eventId: have.eventId, spec });
  }
  for (const [key, have] of Object.entries(map)) {
    if (desired.has(key)) continue;
    if (have.detached) ops.push({ kind: "forget", key });
    else if (key.startsWith("t:")) ops.push({ kind: "delete", key, eventId: have.eventId });
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
  /** The event as the calendar holds it now; null when it was deleted; undefined when it can't be read (skip it). */
  readEvent(eventId: string): Promise<ReadEvent | null | undefined>;
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
type ExpoLikeEvent = {
  title?: string;
  startDate?: string | Date;
  endDate?: string | Date;
  allDay?: boolean;
  lastModifiedDate?: string | Date | null;
  update(details: Partial<EventDetails>): Promise<void>;
  delete(): Promise<void>;
};
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
    readEvent: async (id) => {
      let e: ExpoLikeEvent;
      try {
        e = await getEvent(id);
      } catch {
        return null; // not found: deleted in the calendar app
      }
      return e.startDate && e.endDate ? readBack({ ...e, startDate: e.startDate, endDate: e.endDate }, opts.allDayUtc) : undefined;
    },
    deleteEvent: async (id) => (await getEvent(id)).delete(),
  };
}

/* ------------------------------------------------------------------ two-way: the user's edits in the calendar */

export type ReadEvent = EventSpec & { lastModified: number | null };

/** An event read from the calendar, in the same shape as EventSpec (so its hash compares with the map's). */
export function readBack(
  e: { title?: string; startDate: string | Date; endDate: string | Date; allDay?: boolean; lastModifiedDate?: string | Date | null },
  allDayUtc: boolean,
): ReadEvent {
  const start = new Date(e.startDate);
  const lastModified = e.lastModifiedDate ? new Date(e.lastModifiedDate).getTime() : null;
  if (e.allDay) {
    // Android keeps all-day events at UTC midnight: that UTC day is the local day.
    const ymd = allDayUtc ? start.toISOString().slice(0, 10) : ymdFromLocalDate(start);
    return { title: e.title ?? "", ...dayBounds(ymd), allDay: true, lastModified };
  }
  return { title: e.title ?? "", start: start.toISOString(), end: new Date(e.endDate).toISOString(), allDay: false, lastModified };
}

export type TaskPatch = Partial<{ title: string; status: "COMPLETED" | "PENDING"; scheduledStart: string; scheduledEnd: string; dueDate: string; dueTime: string | null }>;
export type Pulled =
  /** The calendar edit wins: apply `changes` to the task. */
  | { kind: "apply"; taskId: string; title: string; changes: TaskPatch; what: Array<"moved" | "renamed" | "done" | "reopened"> }
  /** Deleted in the calendar: the task is kept. */
  | { kind: "removed"; taskId: string; title: string }
  /** Both changed since the last sync and the app's change is newer: the app's version goes back to the calendar. */
  | { kind: "kept"; taskId: string; title: string };

const stripDone = (title: string) => title.replace(/^\s*✓\s*/, "");

/**
 * What the user changed in the calendar, for each of the app's task events read back (`read`: key → event, or null
 * when it was deleted). An event that reads back with the hash the app last wrote is untouched. A conflict (the task
 * also changed since the last sync) goes to the newer side: the event's last-modified time when the calendar gives one
 * (iOS), else the calendar edit counts as newer (it was just found). The new map stores the read-back hash, so the
 * change the app then makes to the task doesn't write the event again (no loop).
 * Deleting an event never deletes the task: the entry is detached and the user is told the task is still in the app.
 */
export function pullChanges(map: EventMap, read: Map<string, ReadEvent | null>, tasks: TaskWithTime[]): { pulled: Pulled[]; map: EventMap } {
  const next: EventMap = { ...map };
  const pulled: Pulled[] = [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const [key, ev] of read) {
    const have = map[key];
    const task = key.startsWith("t:") ? byId.get(key.slice(2)) : undefined;
    if (!have || have.detached || !task) continue;
    const desired = taskEvent(task);
    if (!desired) continue; // the app removes it anyway
    if (!ev) {
      next[key] = { ...have, detached: true };
      pulled.push({ kind: "removed", taskId: task.id, title: task.title });
      continue;
    }
    const readHash = hashOf(ev);
    if (readHash === have.hash) continue;
    if (hashOf(desired) !== have.hash && ev.lastModified !== null && Date.parse(task.updatedAt) > ev.lastModified) {
      pulled.push({ kind: "kept", taskId: task.id, title: task.title });
      continue;
    }
    const changes: TaskPatch = {};
    const what: Array<"moved" | "renamed" | "done" | "reopened"> = [];
    const title = stripDone(ev.title).trim();
    if (title && title !== task.title) {
      changes.title = title;
      what.push("renamed");
    }
    const done = /^\s*✓/.test(ev.title);
    if (done && task.status !== "COMPLETED") {
      changes.status = "COMPLETED";
      what.push("done");
    } else if (!done && task.status === "COMPLETED") {
      changes.status = "PENDING";
      what.push("reopened");
    }
    if (task.scheduledStart) {
      if (!ev.allDay && (ev.start !== desired.start || ev.end !== desired.end)) {
        changes.scheduledStart = ev.start;
        changes.scheduledEnd = ev.end;
        what.push("moved");
      }
    } else if (ev.start !== desired.start || ev.allDay !== desired.allDay) {
      // The event is the due time (or day): moving it moves the deadline.
      const start = new Date(ev.start);
      changes.dueDate = new Date(`${ymdFromLocalDate(start)}T00:00:00`).toISOString();
      changes.dueTime = ev.allDay ? null : formatDueTime12h(start);
      what.push("moved");
    }
    next[key] = { eventId: have.eventId, hash: readHash, start: ev.start };
    if (what.length) pulled.push({ kind: "apply", taskId: task.id, title: task.title, changes, what });
  }
  return { pulled, map: next };
}

/** One short note for what a sync brought back: the string key, its values, and the task to open (one task only). */
export function pulledNote(pulled: Pulled[]): { key: `calendar.pulled.${string}`; vars: Record<string, string>; taskId: string | null } | null {
  if (!pulled.length) return null;
  if (pulled.length > 1) return { key: "calendar.pulled.many", vars: { count: String(pulled.length) }, taskId: null };
  const p = pulled[0];
  const vars = { title: p.kind === "apply" && p.changes.title ? p.changes.title : p.title };
  if (p.kind !== "apply") return { key: `calendar.pulled.${p.kind}`, vars, taskId: p.taskId };
  return { key: p.what.length === 1 ? `calendar.pulled.${p.what[0]}` : "calendar.pulled.changed", vars, taskId: p.taskId };
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
