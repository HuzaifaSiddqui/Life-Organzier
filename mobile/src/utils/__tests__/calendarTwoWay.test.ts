import { describe, expect, it } from "vitest";
import type { Task } from "../../types/models";
import { applyOps, desiredEvents, expoPort, planOps, pulledNote, pullChanges, readBack, type EventMap, type ReadEvent, type TaskPatch } from "../calendarSync";
import { mockExpoCalendar } from "./mockCalendar";

/** CALENDAR_SYNC two-way: the user's edits to the app's own task events come back to the tasks. */

const FRIDAY_3PM = "2026-11-06T10:00:00.000Z";
const SYNCED_AT = "2026-11-01T00:00:00.000Z";
const task = (over: Partial<Task>): Task =>
  ({ id: "t1", title: "Physics report", status: "PENDING", dueDate: "2026-11-06T00:00:00.000Z", dueTime: "3:00 PM", dueAt: FRIDAY_3PM, scheduledStart: null, scheduledEnd: null, durationMinutes: null, archived: false, updatedAt: SYNCED_AT, ...over }) as Task;

type Cal = ReturnType<typeof mockExpoCalendar>;
const push = async (cal: Cal, tasks: Task[], map: EventMap) => (await applyOps(cal.port, planOps(desiredEvents(tasks, null), map, null), map)).map;
async function readAll(cal: Cal, map: EventMap): Promise<Map<string, ReadEvent | null>> {
  const read = new Map<string, ReadEvent | null>();
  for (const [k, e] of Object.entries(map)) {
    const ev = e.detached ? undefined : await cal.port.readEvent(e.eventId);
    if (ev !== undefined) read.set(k, ev);
  }
  return read;
}
const apply = (t: Task, c: TaskPatch): Task => ({ ...t, ...c, ...(c.dueDate || c.dueTime !== undefined ? { dueAt: c.dueDate && c.dueTime ? null : t.dueAt } : {}) }) as Task;
/** One full sync like calendar.ts runSync: read back, pull, apply to the tasks, then push. */
async function fullSync(cal: Cal, tasks: Task[], map: EventMap) {
  const pulled = pullChanges(map, await readAll(cal, map), tasks);
  let next = tasks;
  for (const p of pulled.pulled) if (p.kind === "apply") next = next.map((t) => (t.id === p.taskId ? apply(t, p.changes) : t));
  const ops = planOps(desiredEvents(next, null), pulled.map, null);
  const out = await applyOps(cal.port, ops, pulled.map);
  return { tasks: next, map: out.map, pulled: pulled.pulled, ops };
}

describe("two-way calendar sync (the app's own task events)", () => {
  it("a moved work block moves the task's planned time, and the next sync writes nothing (no loop)", async () => {
    const cal = mockExpoCalendar();
    let tasks = [task({ scheduledStart: "2026-11-05T09:00:00.000Z", scheduledEnd: "2026-11-05T10:00:00.000Z" })];
    let map = await push(cal, tasks, {});
    const id = map["t:t1"].eventId;
    cal.events.set(id, { ...cal.events.get(id)!, startDate: new Date("2026-11-05T12:00:00.000Z"), endDate: new Date("2026-11-05T13:30:00.000Z") });
    const r = await fullSync(cal, tasks, map);
    expect(r.pulled).toEqual([{ kind: "apply", taskId: "t1", title: "Physics report", changes: { scheduledStart: "2026-11-05T12:00:00.000Z", scheduledEnd: "2026-11-05T13:30:00.000Z" }, what: ["moved"] }]);
    expect(r.ops).toEqual([]);
    tasks = r.tasks;
    map = r.map;
    const before = { ...cal.calls };
    const again = await fullSync(cal, tasks, map);
    expect(again.pulled).toEqual([]);
    expect(again.ops).toEqual([]);
    expect(cal.calls).toEqual(before);
  });

  it("a moved due-time event moves the deadline; a renamed one renames the task", async () => {
    const cal = mockExpoCalendar();
    const tasks = [task({})];
    const map = await push(cal, tasks, {});
    const id = map["t:t1"].eventId;
    const at = new Date(2026, 10, 7, 16, 0);
    cal.events.set(id, { ...cal.events.get(id)!, title: "Physics report v2", startDate: at, endDate: new Date(at.getTime() + 30 * 60000) });
    const { pulled } = pullChanges(map, await readAll(cal, map), tasks);
    expect(pulled[0]).toMatchObject({ kind: "apply", what: ["renamed", "moved"], changes: { title: "Physics report v2", dueDate: new Date(2026, 10, 7).toISOString(), dueTime: "4:00 PM" } });
    expect(pulledNote(pulled)).toEqual({ key: "calendar.pulled.changed", vars: { title: "Physics report v2" }, taskId: "t1" });
  });

  it("\"✓\" in front marks it done; taking it off reopens it", async () => {
    const cal = mockExpoCalendar();
    const tasks = [task({})];
    const map = await push(cal, tasks, {});
    const id = map["t:t1"].eventId;
    cal.events.set(id, { ...cal.events.get(id)!, title: "✓Physics report" });
    const done = pullChanges(map, await readAll(cal, map), tasks);
    expect(done.pulled[0]).toMatchObject({ changes: { status: "COMPLETED" }, what: ["done"] });
    const completed = [task({ status: "COMPLETED" })];
    const m2 = await push(cal, completed, {});
    const id2 = m2["t:t1"].eventId;
    cal.events.set(id2, { ...cal.events.get(id2)!, title: "Physics report" });
    expect(pullChanges(m2, await readAll(cal, m2), completed).pulled[0]).toMatchObject({ changes: { status: "PENDING" }, what: ["reopened"] });
  });

  it("deleting the event never deletes the task: it stays, the user is told, no event is made again until the task changes", async () => {
    const cal = mockExpoCalendar();
    const tasks = [task({})];
    let map = await push(cal, tasks, {});
    cal.events.delete(map["t:t1"].eventId);
    const r = await fullSync(cal, tasks, map);
    expect(r.pulled).toEqual([{ kind: "removed", taskId: "t1", title: "Physics report" }]);
    expect(r.tasks).toEqual(tasks);
    expect(r.map["t:t1"].detached).toBe(true);
    expect(cal.events.size).toBe(0);
    map = r.map;
    expect((await fullSync(cal, tasks, map)).ops).toEqual([]);
    expect(pulledNote(r.pulled)?.key).toBe("calendar.pulled.removed");
    // The task changes in the app: it's added back.
    const moved = [task({ dueAt: "2026-11-06T11:00:00.000Z", dueTime: "4:00 PM" })];
    expect(planOps(desiredEvents(moved, null), map, null)).toMatchObject([{ kind: "create", key: "t:t1" }]);
    // The task is deleted later: the detached entry is just forgotten.
    expect(planOps(desiredEvents([], null), map, null)).toEqual([{ kind: "forget", key: "t:t1" }]);
  });

  it("conflict: both changed since the last sync, the newer side wins", async () => {
    const cal = mockExpoCalendar();
    const tasks = [task({})];
    const map = await push(cal, tasks, {});
    const id = map["t:t1"].eventId;
    cal.events.set(id, { ...cal.events.get(id)!, title: "Calendar title" });
    const read = await readAll(cal, map);
    const ev = read.get("t:t1")!;
    const appEdited = [task({ title: "App title", updatedAt: "2026-11-02T12:00:00.000Z" })];
    // Calendar edited earlier than the app edit: the app's version is kept (and goes back to the calendar).
    const older = new Map([["t:t1", { ...ev, lastModified: Date.parse("2026-11-02T08:00:00.000Z") }]]);
    expect(pullChanges(map, older, appEdited).pulled).toEqual([{ kind: "kept", taskId: "t1", title: "App title" }]);
    // Calendar edited later: the calendar wins.
    const newer = new Map([["t:t1", { ...ev, lastModified: Date.parse("2026-11-02T18:00:00.000Z") }]]);
    expect(pullChanges(map, newer, appEdited).pulled[0]).toMatchObject({ kind: "apply", changes: { title: "Calendar title" } });
    // No last-modified time (Android): the calendar edit, just found, counts as newer.
    expect(pullChanges(map, read, appEdited).pulled[0]).toMatchObject({ kind: "apply" });
  });

  it("untouched events and routine events are left alone; several changes make one note", async () => {
    const cal = mockExpoCalendar();
    const tasks = [task({}), task({ id: "t2", title: "Essay" })];
    const map = await push(cal, tasks, {});
    expect(pullChanges(map, await readAll(cal, map), tasks).pulled).toEqual([]);
    const withRoutine: EventMap = { ...map, "r:o1": { eventId: "x", hash: "h", start: FRIDAY_3PM } };
    expect(pullChanges(withRoutine, new Map([["r:o1", null]]), tasks).pulled).toEqual([]);
    expect(pulledNote([{ kind: "removed", taskId: "t1", title: "a" }, { kind: "removed", taskId: "t2", title: "b" }])).toEqual({ key: "calendar.pulled.many", vars: { count: "2" }, taskId: null });
  });

  it("read-back: a deleted event reads as null (detach); one without times is skipped, never treated as deleted", async () => {
    const port = expoPort({ createEvent: async () => ({ id: "x" }) }, async (id) => {
      if (id === "gone") throw new Error("not found");
      return { update: async () => undefined, delete: async () => undefined };
    }, { timeZone: "Asia/Karachi", allDayUtc: true });
    expect(await port.readEvent("gone")).toBeNull();
    expect(await port.readEvent("partial")).toBeUndefined();
  });

  it("read-back: Android all-day events at UTC midnight are the local day", () => {
    const r = readBack({ title: "x", startDate: "2026-11-06T00:00:00.000Z", endDate: "2026-11-07T00:00:00.000Z", allDay: true }, true);
    expect(r).toMatchObject({ allDay: true, start: new Date(2026, 10, 6).toISOString(), end: new Date(2026, 10, 7).toISOString() });
  });
});
