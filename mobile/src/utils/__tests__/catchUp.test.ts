import { describe, expect, it } from "vitest";
import type { Task } from "../../types/models";
import { catchUpChange, catchUpQueue, moveDate } from "../catchUp";

const now = new Date(2026, 10, 17, 14, 0); // Tue 2 PM
const at = (d: number, h = 9) => new Date(2026, 10, d, h, 0).toISOString();
const task = (o: Partial<Task>): Task => ({ id: o.id ?? "t", userId: "u", title: "T", description: null, dueDate: null, dueTime: null, dueAt: null, priority: "MEDIUM", category: null, status: "PENDING", source: "MANUAL", confidence: null, createdAt: at(1), updatedAt: at(1), ...o }) as Task;

describe("Catch up", () => {
  it("queues overdue top-level tasks, oldest first", () => {
    const q = catchUpQueue(
      [
        task({ id: "b", dueAt: at(12) }),
        task({ id: "a", dueAt: at(3) }),
        task({ id: "future", dueAt: at(20) }),
        task({ id: "done", dueAt: at(3), status: "COMPLETED" }),
        task({ id: "step", dueAt: at(3), parentTaskId: "a" }),
      ],
      now,
    );
    expect(q.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("dates: today, tomorrow, next Monday, a picked day", () => {
    expect(moveDate("today", now)).toBe("2026-11-17");
    expect(moveDate("tomorrow", now)).toBe("2026-11-18");
    expect(moveDate("nextWeek", now)).toBe("2026-11-23");
    expect(moveDate({ ymd: "2026-12-01" }, now)).toBe("2026-12-01");
  });

  it("keeps the time unless it has already passed today; clears a stale planned block", () => {
    expect(catchUpChange(task({ dueTime: "18:00" }), "today", now)).toEqual({ dueDate: "2026-11-17", dueTime: "18:00" });
    expect(catchUpChange(task({ dueTime: "9:00 AM" }), "today", now)).toEqual({ dueDate: "2026-11-17", dueTime: null });
    expect(catchUpChange(task({ dueTime: "9:00 AM" }), "tomorrow", now)).toEqual({ dueDate: "2026-11-18", dueTime: "9:00 AM" });
    expect(catchUpChange(task({ scheduledStart: at(10), scheduledEnd: at(10, 11) }), "nextWeek", now)).toEqual({ dueDate: "2026-11-23", dueTime: null, scheduledStart: null, scheduledEnd: null });
  });
});
