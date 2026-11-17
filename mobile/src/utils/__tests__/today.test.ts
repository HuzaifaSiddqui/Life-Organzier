import { describe, expect, it } from "vitest";
import type { Task } from "../../types/models";
import { dayPart, firstName, nudgesFrom, todayAgenda } from "../today";

const at = (h: number, m = 0, d = 17) => new Date(2026, 10, d, h, m).toISOString();
const now = new Date(2026, 10, 17, 12, 0);
const task = (o: Partial<Task>): Task => ({ id: "t", userId: "u", title: "T", description: null, dueDate: null, dueTime: null, dueAt: null, priority: "MEDIUM", category: null, status: "PENDING", source: "MANUAL", confidence: null, createdAt: at(8), updatedAt: at(8), ...o }) as Task;

describe("Today agenda", () => {
  it("splits today's items around now and counts honestly (earlier days' overdue apart)", () => {
    const a = todayAgenda(
      [
        task({ id: "morning", dueAt: at(9), dueTime: "09:00", status: "COMPLETED" }),
        task({ id: "late", dueAt: at(10), dueTime: "10:00" }),
        task({ id: "after", dueAt: at(15), dueTime: "15:00", durationMinutes: 60 }),
        task({ id: "any", dueAt: at(23, 59), dueTime: null }),
        task({ id: "old", dueAt: at(9, 0, 10), dueTime: "09:00" }),
        task({ id: "oldDone", dueAt: at(9, 0, 10), dueTime: "09:00", status: "COMPLETED" }),
      ],
      [],
      now,
    );
    expect(a.earlier.map((i) => i.id)).toEqual(["morning", "late"]);
    expect(a.later.map((i) => i.id)).toEqual(["after"]);
    expect(a.anyTime.map((i) => i.id)).toEqual(["any"]);
    expect([a.total, a.done, a.left, a.overdueBefore]).toEqual([4, 1, 3, 1]);
    expect(a.plannedMinutes).toBe(60);
  });

  it("first name, capitalised; part of the day", () => {
    expect(firstName("yasir imran")).toBe("Yasir");
    expect(firstName("  ")).toBe(null);
    expect(dayPart(new Date(2026, 10, 17, 8))).toBe("morning");
    expect(dayPart(new Date(2026, 10, 17, 13))).toBe("afternoon");
    expect(dayPart(new Date(2026, 10, 17, 19))).toBe("evening");
  });
});

describe("Today nudges", () => {
  it("drops FYIs and overdue rows (Catch up covers those), most urgent first, minus dismissed", () => {
    const a = (id: string, kind: string, severity: "info" | "warning" | "critical") => ({ id, kind, severity, title: id, message: "", actions: [] });
    const list = [a("bed", "missed_routine_locked", "info"), a("reels", "overdue_deadline", "critical"), a("stuck", "stuck", "info"), a("load", "overloaded_day", "warning"), a("gym", "missed_routine_flexible", "warning")];
    expect(nudgesFrom(list).map((x) => x.id)).toEqual(["load", "gym", "stuck"]);
    expect(nudgesFrom(list, new Set(["load"])).map((x) => x.id)).toEqual(["gym", "stuck"]);
  });
});
