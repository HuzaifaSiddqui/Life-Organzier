import { describe, expect, it } from "vitest";
import type { Task } from "../../types/models";
import { atClock, clashesWith, eventKey, freeSlots, importCandidates, pruneDecided, taskFromEvent, taskSpan, type PhoneEvent } from "../calendarSync";

const task = (over: Partial<Task>): Task =>
  ({ id: "t1", title: "Physics report", status: "PENDING", dueDate: null, dueTime: null, dueAt: null, scheduledStart: null, scheduledEnd: null, durationMinutes: null, archived: false, ...over }) as Task;

const FRIDAY_3PM = "2026-11-06T10:00:00.000Z";
const dated = task({ dueDate: "2026-11-06T00:00:00.000Z", dueTime: "3 PM", dueAt: FRIDAY_3PM });
const NOW = Date.parse("2026-11-05T05:00:00.000Z");
const ev = (over: Partial<PhoneEvent> & { id: string }): PhoneEvent => ({
  title: "Dentist",
  startDate: "2026-11-06T11:00:00.000Z",
  endDate: "2026-11-06T11:45:00.000Z",
  allDay: false,
  notes: "",
  location: null,
  ...over,
});

describe("one-way import: which calendar events are offered", () => {
  it("upcoming events are offered once, sorted by start; ended, untitled and old app-written events are not", () => {
    const events = [
      ev({ id: "b", title: "Team meeting", startDate: "2026-11-07T04:00:00.000Z", endDate: "2026-11-07T05:00:00.000Z" }),
      ev({ id: "a" }),
      ev({ id: "a" }), // the same instance twice (two calendars listed)
      ev({ id: "old", startDate: "2026-11-04T04:00:00.000Z", endDate: "2026-11-04T05:00:00.000Z" }),
      ev({ id: "ours", title: "Physics report", notes: "Created by Life Organizer" }),
      ev({ id: "blank", title: "  " }),
    ];
    const out = importCandidates(events, {}, [], NOW);
    expect(out.map((c) => c.title)).toEqual(["Dentist", "Team meeting"]);
    expect(out[0]).toEqual({ key: "a@2026-11-06T11:00:00.000Z", title: "Dentist", start: "2026-11-06T11:00:00.000Z", end: "2026-11-06T11:45:00.000Z", allDay: false, location: null });
  });

  it("each instance of a repeating event is its own; added or skipped ones are not offered again", () => {
    const monday = ev({ id: "class", title: "Lab", startDate: "2026-11-09T04:00:00.000Z", endDate: "2026-11-09T05:00:00.000Z" });
    const nextMonday = { ...monday, startDate: "2026-11-16T04:00:00.000Z", endDate: "2026-11-16T05:00:00.000Z" };
    expect(importCandidates([monday, nextMonday], {}, [], NOW)).toHaveLength(2);
    const decided = { [eventKey(monday)]: Date.parse("2026-11-09T04:00:00.000Z") };
    expect(importCandidates([monday, nextMonday], decided, [], NOW).map((c) => c.start)).toEqual(["2026-11-16T04:00:00.000Z"]);
  });

  it("an event already in the app (same title, same start or same day) is not offered", () => {
    const planned = task({ title: "dentist", scheduledStart: "2026-11-06T11:00:00.000Z" });
    expect(importCandidates([ev({ id: "a" })], {}, [planned], NOW)).toEqual([]);
    expect(importCandidates([ev({ id: "a" })], {}, [{ ...planned, status: "DELETED" }], NOW)).toHaveLength(1);
    const allDay = ev({ id: "h", title: "Holiday", allDay: true, startDate: new Date(2026, 10, 9).toISOString(), endDate: new Date(2026, 10, 10).toISOString() });
    expect(importCandidates([allDay], {}, [task({ title: "Holiday", dueDate: new Date(2026, 10, 9).toISOString() })], NOW)).toEqual([]);
  });

  it("decisions for events that started over a day ago are forgotten", () => {
    expect(pruneDecided({ old: NOW - 2 * 86400000, recent: NOW - 3600000, soon: NOW + 3600000 }, NOW)).toEqual({ recent: NOW - 3600000, soon: NOW + 3600000 });
  });
});

describe("one-way import: the task made from an event", () => {
  it("a timed event is planned for its span, due on its day at its start time", () => {
    const start = new Date(2026, 10, 6, 16, 0).toISOString();
    const end = new Date(2026, 10, 6, 16, 45).toISOString();
    const t = taskFromEvent({ key: "a", title: "Dentist", start, end, allDay: false, location: "Clinic, F-7" }, "From your calendar");
    expect(t).toMatchObject({
      title: "Dentist",
      description: "From your calendar\nClinic, F-7",
      dueDate: new Date(2026, 10, 6).toISOString(),
      dueTime: "4:00 PM",
      durationMinutes: 45,
      scheduledStart: start,
      scheduledEnd: end,
      taskType: "FIXED",
      source: "MANUAL",
    });
  });

  it("an all-day event is due that day with no time; Android's UTC all-day dates keep their day", () => {
    const local = taskFromEvent({ key: "h", title: "Holiday", start: new Date(2026, 10, 9).toISOString(), end: new Date(2026, 10, 10).toISOString(), allDay: true, location: null }, "From your calendar");
    expect(local).toMatchObject({ dueDate: new Date(2026, 10, 9).toISOString(), dueTime: null, taskType: "DEADLINE", description: "From your calendar" });
    expect(local.scheduledStart).toBeUndefined();
    const utc = taskFromEvent({ key: "h", title: "Holiday", start: "2026-11-09T00:00:00.000Z", end: "2026-11-10T00:00:00.000Z", allDay: true, location: null }, "x", true);
    expect(utc.dueDate).toBe(new Date(2026, 10, 9).toISOString());
  });
});

describe("busy time (clash warning, free time)", () => {
  const lecture = { title: "Lecture", start: Date.parse("2026-11-06T09:30:00.000Z"), end: Date.parse("2026-11-06T10:30:00.000Z"), allDay: false };
  const holiday = { title: "Holiday", start: Date.parse("2026-11-05T19:00:00.000Z"), end: Date.parse("2026-11-06T19:00:00.000Z"), allDay: true };
  const tentative = { title: "Maybe coffee", start: Date.parse("2026-11-06T10:00:00.000Z"), end: Date.parse("2026-11-06T11:00:00.000Z"), allDay: false, free: true };

  it("a task's span: its work block, else 30 minutes at the due time, else none", () => {
    expect(taskSpan(dated)).toEqual({ start: Date.parse(FRIDAY_3PM), end: Date.parse("2026-11-06T10:30:00.000Z") });
    expect(taskSpan({ ...dated, scheduledStart: "2026-11-05T09:00:00.000Z", durationMinutes: 120 })).toEqual({ start: Date.parse("2026-11-05T09:00:00.000Z"), end: Date.parse("2026-11-05T11:00:00.000Z") });
    expect(taskSpan(task({ dueDate: "2026-11-06T00:00:00.000Z" }))).toBeNull();
  });

  it("overlap clashes; touching, all-day and free events don't", () => {
    const span = taskSpan(dated)!;
    expect(clashesWith([lecture, holiday, tentative], span.start, span.end).map((b) => b.title)).toEqual(["Lecture"]);
    expect(clashesWith([lecture], Date.parse("2026-11-06T10:30:00.000Z"), Date.parse("2026-11-06T11:00:00.000Z"))).toEqual([]);
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
