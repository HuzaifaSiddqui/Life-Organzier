import { describe, expect, it } from "vitest";
import type { Task } from "../../types/models";
import {
  applyOps,
  atClock,
  clashesWith,
  desiredEvents,
  expoPort,
  freeSlots,
  freeTitle,
  planOps,
  taskEvent,
  taskSpan,
  type EventMap,
  type Feed,
} from "../calendarSync";

/**
 * A mocked expo-calendar: an ExpoCalendar whose createEvent stores events, and ExpoCalendarEvent.get for update /
 * delete (throws for an event the user deleted in the calendar app). Tests drive the sync through expoPort.
 */
function mockExpoCalendar() {
  const events = new Map<string, { title: string; startDate: Date; endDate: Date; allDay: boolean; timeZone: string }>();
  let n = 0;
  const calls = { create: 0, update: 0, delete: 0 };
  const calendar = {
    createEvent: async (d: { title: string; startDate: Date; endDate: Date; allDay: boolean; timeZone: string }) => {
      calls.create += 1;
      const id = `ev${++n}`;
      events.set(id, d);
      return { id };
    },
  };
  const get = async (id: string) => {
    if (!events.has(id)) throw new Error("Event not found");
    return {
      update: async (d: object) => {
        calls.update += 1;
        events.set(id, { ...events.get(id)!, ...d });
      },
      delete: async () => {
        calls.delete += 1;
        events.delete(id);
      },
    };
  };
  return { events, calls, port: expoPort(calendar, get, { timeZone: "Asia/Karachi", allDayUtc: false }) };
}

const task = (over: Partial<Task>): Task =>
  ({ id: "t1", title: "Physics report", status: "PENDING", dueDate: null, dueTime: null, dueAt: null, scheduledStart: null, scheduledEnd: null, durationMinutes: null, archived: false, ...over }) as Task;

const FRIDAY_3PM = "2026-11-06T10:00:00.000Z";
const dated = task({ dueDate: "2026-11-06T00:00:00.000Z", dueTime: "3 PM", dueAt: FRIDAY_3PM });
const feed = (occurrences: Feed["occurrences"]): Feed => ({ windowStart: "2026-11-03T19:00:00.000Z", windowEnd: "2026-11-17T19:00:00.000Z", occurrences });
const gym = (id: string, start: string, status = "PENDING") => ({ id, title: "Gym", start, end: new Date(Date.parse(start) + 45 * 60000).toISOString(), allDay: false, status });

async function sync(cal: ReturnType<typeof mockExpoCalendar>, tasks: Task[], f: Feed | null, map: EventMap) {
  return (await applyOps(cal.port, planOps(desiredEvents(tasks, f), map, f), map)).map;
}

describe("calendar events from tasks", () => {
  it("a timed deadline is 30 min at the due time; a work block wins; a date-only deadline is all-day; no date: none", () => {
    expect(taskEvent(dated)).toEqual({ title: "Physics report", start: FRIDAY_3PM, end: "2026-11-06T10:30:00.000Z", allDay: false });
    expect(taskEvent({ ...dated, scheduledStart: "2026-11-05T09:00:00.000Z", durationMinutes: 120 })).toMatchObject({ start: "2026-11-05T09:00:00.000Z", end: "2026-11-05T11:00:00.000Z" });
    const allDay = taskEvent(task({ dueDate: new Date(2026, 10, 6).toISOString() }));
    expect(allDay).toMatchObject({ allDay: true, start: new Date(2026, 10, 6).toISOString(), end: new Date(2026, 10, 7).toISOString() });
    expect(taskEvent(task({}))).toBeNull();
    expect(taskEvent({ ...dated, status: "DELETED" })).toBeNull();
    expect(taskEvent({ ...dated, archived: true })).toBeNull();
    expect(taskEvent({ ...dated, status: "COMPLETED" })?.title).toBe("✓ Physics report");
  });
});

describe("eventId sync (mocked expo-calendar)", () => {
  it("create, edit, complete, delete and undo: one event per task, never a duplicate", async () => {
    const cal = mockExpoCalendar();
    let map = await sync(cal, [dated], null, {});
    expect(cal.events.size).toBe(1);
    const id = map["t:t1"].eventId;

    map = await sync(cal, [dated], null, map); // nothing changed: no calls
    expect(cal.calls).toEqual({ create: 1, update: 0, delete: 0 });

    const moved = { ...dated, dueAt: "2026-11-09T10:00:00.000Z", dueDate: "2026-11-09T00:00:00.000Z" };
    map = await sync(cal, [moved], null, map); // edit → same event updated
    expect(map["t:t1"].eventId).toBe(id);
    expect(cal.events.get(id)?.startDate.toISOString()).toBe("2026-11-09T10:00:00.000Z");

    map = await sync(cal, [{ ...moved, status: "COMPLETED" }], null, map);
    expect(cal.events.get(id)?.title).toBe("✓ Physics report");
    map = await sync(cal, [{ ...moved, status: "PENDING" }], null, map); // reopened / undo of complete
    expect(cal.events.get(id)?.title).toBe("Physics report");

    map = await sync(cal, [{ ...moved, status: "DELETED" }], null, map);
    expect(cal.events.size).toBe(0);
    expect(map["t:t1"]).toBeUndefined();

    map = await sync(cal, [moved], null, map); // undo delete → back once
    expect(cal.events.size).toBe(1);
    map = await sync(cal, [moved], null, map);
    expect(cal.events.size).toBe(1);
  });

  it("an event deleted in the calendar app comes back on the task's next change; a task that loses its date loses its event", async () => {
    const cal = mockExpoCalendar();
    let map = await sync(cal, [dated], null, {});
    cal.events.clear();
    map = await sync(cal, [{ ...dated, title: "Physics report v2" }], null, map);
    expect(cal.events.size).toBe(1);
    expect([...cal.events.values()][0].title).toBe("Physics report v2");
    map = await sync(cal, [{ ...dated, dueDate: null, dueTime: null, dueAt: null }], null, map);
    expect(cal.events.size).toBe(0);
  });

  it("routine occurrences: added and marked done; a removed one inside the window is deleted, a past one is kept and forgotten; offline leaves them alone", async () => {
    const cal = mockExpoCalendar();
    const thu = gym("o1", "2026-11-05T14:00:00.000Z");
    const fri = gym("o2", "2026-11-06T14:00:00.000Z");
    let map = await sync(cal, [], feed([thu, fri]), {});
    expect(cal.events.size).toBe(2);

    map = await sync(cal, [], feed([{ ...thu, status: "COMPLETED" }, fri]), map);
    expect(cal.events.get(map["r:o1"].eventId)?.title).toBe("✓ Gym");

    map = await sync(cal, [], null, map); // feed unavailable: nothing touched
    expect(cal.events.size).toBe(2);

    map = await sync(cal, [], feed([thu]), map); // routine paused for Friday
    expect(cal.events.size).toBe(1);

    const later = { windowStart: "2026-11-06T19:00:00.000Z", windowEnd: "2026-11-20T19:00:00.000Z", occurrences: [] };
    map = await sync(cal, [], later, map); // Thursday is now in the past: history stays in the calendar
    expect(cal.events.size).toBe(1);
    expect(map).toEqual({});
  });

  it("Android all-day events go to UTC midnight in the UTC zone", async () => {
    const created: Array<{ startDate: Date; timeZone: string }> = [];
    const port = expoPort({ createEvent: async (d) => (created.push(d), { id: "x" }) }, async () => ({ update: async () => undefined, delete: async () => undefined }), { timeZone: "Asia/Karachi", allDayUtc: true });
    await port.createEvent({ title: "Essay", start: new Date(2026, 10, 6).toISOString(), end: new Date(2026, 10, 7).toISOString(), allDay: true });
    expect(created[0]).toMatchObject({ startDate: new Date("2026-11-06T00:00:00.000Z"), timeZone: "UTC", notes: "Created by Life Organizer" });
  });

  it("a new calendar's title avoids taken names", () => {
    expect(freeTitle(["Work"])).toBe("Life Organizer");
    expect(freeTitle(["Life Organizer"])).toBe("Life Organizer (2)");
    expect(freeTitle(["Life Organizer", "Life Organizer (2)"])).toBe("Life Organizer (3)");
  });
});

describe("busy time (clash warning, free time)", () => {
  const lecture = { title: "Lecture", start: Date.parse("2026-11-06T09:30:00.000Z"), end: Date.parse("2026-11-06T10:30:00.000Z"), allDay: false };
  const holiday = { title: "Holiday", start: Date.parse("2026-11-05T19:00:00.000Z"), end: Date.parse("2026-11-06T19:00:00.000Z"), allDay: true };
  const tentative = { title: "Maybe coffee", start: Date.parse("2026-11-06T10:00:00.000Z"), end: Date.parse("2026-11-06T11:00:00.000Z"), allDay: false, free: true };

  it("overlap clashes; touching, all-day and free events don't", () => {
    const span = taskSpan(dated)!;
    expect(clashesWith([lecture, holiday, tentative], span.start, span.end).map((b) => b.title)).toEqual(["Lecture"]);
    expect(clashesWith([lecture], Date.parse("2026-11-06T10:30:00.000Z"), Date.parse("2026-11-06T11:00:00.000Z"))).toEqual([]);
    expect(taskSpan(task({ dueDate: "2026-11-06T00:00:00.000Z" }))).toBeNull();
  });

  it("free slots around busy events, at least 30 minutes", () => {
    const from = Date.parse("2026-11-06T03:00:00.000Z");
    const to = Date.parse("2026-11-06T17:00:00.000Z");
    const slots = freeSlots([lecture, holiday, { ...lecture, start: lecture.end + 10 * 60000, end: lecture.end + 70 * 60000 }], from, to);
    expect(slots.map((s) => [new Date(s.start).toISOString(), new Date(s.end).toISOString()])).toEqual([
      ["2026-11-06T03:00:00.000Z", "2026-11-06T09:30:00.000Z"],
      ["2026-11-06T11:40:00.000Z", "2026-11-06T17:00:00.000Z"],
    ]);
    expect(atClock("2026-11-06", "08:00")).toBe(new Date(2026, 10, 6, 8, 0).getTime());
  });
});
