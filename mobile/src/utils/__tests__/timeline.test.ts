import { describe, expect, it } from "vitest";
import type { Routine, Task } from "../../types/models";
import { countByDay, dayKey, freeGaps, itemsForDay, layoutColumns, monthGrid, moveChange, parseClock, slotStart, snapMinutes, weekOf, type TimelineItem } from "../timeline";

const day = new Date(2026, 10, 17); // Tue 17 Nov
const now = new Date(2026, 10, 17, 11, 0);
const at = (h: number, m = 0, d = 17) => new Date(2026, 10, d, h, m).toISOString();

function task(o: Partial<Task>): Task {
  return { id: "t", userId: "u", title: "Task", description: null, dueDate: null, dueTime: null, dueAt: null, priority: "MEDIUM", category: null, status: "PENDING", source: "MANUAL", confidence: null, createdAt: at(8), updatedAt: at(8), ...o } as Task;
}
function routine(o: Partial<Routine>, occurrences: Array<{ id: string; date: Date; status?: string; dueTime?: string | null }>): Routine {
  return {
    id: "r", title: "Gym", description: null, frequency: "DAILY", daysOfWeek: null, dayOfMonth: null, dueTime: "18:00", durationMinutes: 60, category: null, priority: "FLEXIBLE", timeLocked: false, locationContext: null, active: true,
    occurrences: occurrences.map((x) => ({ id: x.id, routineId: "r", occurrenceDate: x.date.toISOString(), dueTime: x.dueTime ?? null, status: x.status ?? "PENDING" })),
    ...o,
  } as Routine;
}
const item = (key: string, start: number, end: number): TimelineItem => ({ key, kind: "task", id: key, title: key, start, end, anchor: "due", done: false, muted: false, overdue: false, priority: "MEDIUM", category: null, deadline: true });

describe("Plan timeline", () => {
  it("places planned blocks, due times and routines on the right day; untimed ones go to the all-day row", () => {
    const tasks = [
      task({ id: "plan", scheduledStart: at(9), scheduledEnd: at(10, 30) }),
      task({ id: "due", dueAt: at(14), dueTime: "14:00", durationMinutes: 45 }),
      task({ id: "noTime", dueAt: at(23, 59), dueTime: null }),
      task({ id: "tomorrow", dueAt: at(9, 0, 18), dueTime: "09:00" }),
      task({ id: "deleted", dueAt: at(12), dueTime: "12:00", status: "DELETED" }),
    ];
    const routines = [routine({}, [{ id: "o1", date: day }, { id: "o2", date: new Date(2026, 10, 18) }])];
    const { timed, allDay } = itemsForDay(tasks, routines, day, now);
    expect(timed.map((i) => [i.id, i.start, i.end, i.anchor])).toEqual([
      ["plan", 540, 630, "scheduled"],
      ["due", 840, 885, "due"],
      ["o1", 1080, 1140, "routine"],
    ]);
    expect(allDay.map((i) => i.id)).toEqual(["noTime"]);
  });

  it("marks overdue, done and skipped", () => {
    const tasks = [task({ id: "late", dueAt: at(9), dueTime: "9:00 am" }), task({ id: "done", dueAt: at(8), dueTime: "08:00", status: "COMPLETED" })];
    const routines = [routine({ dueTime: null }, [{ id: "skip", date: day, status: "SKIPPED", dueTime: "07:00" }])];
    const { timed } = itemsForDay(tasks, routines, day, now);
    const by = Object.fromEntries(timed.map((i) => [i.id, i]));
    expect(by.late.overdue).toBe(true);
    expect(by.done.overdue).toBe(false);
    expect(by.done.done).toBe(true);
    expect(by.skip.muted).toBe(true);
    expect(by.skip.start).toBe(420);
  });

  it("puts overlapping items side by side, each cluster sharing its width", () => {
    const placed = layoutColumns([item("a", 540, 600), item("b", 570, 630), item("c", 600, 660), item("d", 700, 730)]);
    const by = Object.fromEntries(placed.map((p) => [p.key, [p.col, p.cols]]));
    expect(by).toEqual({ a: [0, 2], b: [1, 2], c: [0, 2], d: [0, 1] });
  });

  it("snaps drags to 15 minutes inside the day; a tap suggests the half hour", () => {
    expect(snapMinutes(547)).toBe(540);
    expect(snapMinutes(553)).toBe(555);
    expect(snapMinutes(-20)).toBe(0);
    expect(snapMinutes(1439, 60)).toBe(1380);
    expect(slotStart(589)).toBe(570);
    expect(parseClock("12 am")).toBe(0);
    expect(parseClock("25:00")).toBe(null);
  });

  it("a move saves the planned time, the due time, or the routine occurrence", () => {
    const d = new Date(2026, 10, 18);
    expect(moveChange({ ...item("x", 0, 0), anchor: "due" }, d, 615, 645)).toEqual({ kind: "task", id: "x", changes: { dueDate: "2026-11-18", dueTime: "10:15" } });
    const planned = moveChange({ ...item("p", 0, 0), anchor: "scheduled" }, d, 600, 690);
    expect(planned.kind === "task" && planned.changes).toEqual({ scheduledStart: new Date(2026, 10, 18, 10, 0).toISOString(), scheduledEnd: new Date(2026, 10, 18, 11, 30).toISOString() });
    expect(moveChange({ ...item("o", 0, 0), kind: "routine", anchor: "routine" }, d, 1110, 1170)).toEqual({ kind: "routine", id: "o", date: "2026-11-18", time: "18:30" });
  });

  it("weeks start on Monday; a month is 6 full weeks; counts per day", () => {
    expect(weekOf(day).map(dayKey)).toEqual(["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"]);
    const grid = monthGrid(day);
    expect(grid.length).toBe(6);
    expect(dayKey(grid[0][0])).toBe("2026-10-26");
    const counts = countByDay([task({ id: "a", dueAt: at(9), dueTime: "09:00" })], [], [day], now);
    expect(counts["2026-11-17"]).toEqual({ open: 1, done: 0, overdue: 1 });
  });

  it("finds free gaps of half an hour or more", () => {
    expect(freeGaps([item("a", 540, 600), item("b", 610, 700)], 480, 780)).toEqual([
      { start: 480, end: 540 },
      { start: 700, end: 780 },
    ]);
  });
});
