import { describe, expect, it } from "vitest";
import type { Task } from "../../types/models";
import { groupOf, groupTasks, inView, viewCounts } from "../taskViews";

const now = new Date(2026, 10, 17, 12, 0); // Tue
const at = (d: number, h = 10) => new Date(2026, 10, d, h, 0).toISOString();
const task = (o: Partial<Task>): Task => ({ id: o.id ?? "t", userId: "u", title: o.id ?? "T", description: null, dueDate: null, dueTime: null, dueAt: null, priority: "MEDIUM", category: null, status: "PENDING", source: "MANUAL", confidence: null, createdAt: at(1), updatedAt: at(1), ...o }) as Task;

const list = [
  task({ id: "late", dueAt: at(16), dueDate: at(16) }),
  task({ id: "today", dueAt: at(17, 18), dueDate: at(17) }),
  task({ id: "tomorrow", dueAt: at(18), dueDate: at(18) }),
  task({ id: "week", dueAt: at(21), dueDate: at(21) }),
  task({ id: "later", dueAt: at(30), dueDate: at(30) }),
  task({ id: "nodate" }),
  task({ id: "done", dueAt: at(16), status: "COMPLETED" }),
  task({ id: "gone", status: "DELETED" }),
  task({ id: "step", parentTaskId: "today", dueAt: at(17, 18) }),
];

describe("Tasks views", () => {
  it("puts each task in one date group", () => {
    expect(list.slice(0, 7).map((t) => groupOf(t, now))).toEqual(["overdue", "today", "tomorrow", "week", "later", "nodate", "done"]);
  });

  it("smart views: Today includes overdue; Upcoming is after today; deleted never shows", () => {
    const ids = (v: Parameters<typeof inView>[1]) => list.filter((t) => !t.parentTaskId && inView(t, v, now)).map((t) => t.id);
    expect(ids("TODAY")).toEqual(["late", "today"]);
    expect(ids("UPCOMING")).toEqual(["tomorrow", "week", "later"]);
    expect(ids("NODATE")).toEqual(["nodate"]);
    expect(ids("DONE")).toEqual(["done"]);
    expect(viewCounts(list, now)).toEqual({ ALL: 6, TODAY: 2, UPCOMING: 3, NODATE: 1, OVERDUE: 1, DONE: 1 });
  });

  it("sections come in reading order, sorted inside", () => {
    const g = groupTasks(list.filter((t) => t.status !== "DELETED" && !t.parentTaskId), now, (a, b) => a.id.localeCompare(b.id));
    expect(g.map((s) => s.key)).toEqual(["overdue", "today", "tomorrow", "week", "later", "nodate", "done"]);
  });
});
