import { describe, expect, it } from "vitest";
import type { Briefing, Task } from "../../types/models";
import { isEvening, moodCaption, routinesCaption, summaryParts, thenUp, tomorrowPreview } from "../homeCards";
import { addTaskSnooze, NEXT_UP_SNOOZE_MINUTES } from "../taskSnooze";

const task = (id: string, over: Partial<Task> = {}) => ({ id, title: `Task ${id}`, status: "PENDING", dueTime: null, ...over }) as Task;
const routine = (id: string, status: "PENDING" | "COMPLETED" | "MISSED" | "SKIPPED", time: string | null = "7:00 PM") =>
  ({ id, routineId: id, title: `Routine ${id}`, time, status, priority: "NORMAL", timeLocked: false }) as Briefing["today"]["routines"][number];
const today = (tasks: Task[], routines: Briefing["today"]["routines"] = []) => ({ tasks, routines, loadMinutes: 0, capacityMinutes: 480 });

describe("Home summary line", () => {
  it("shows overdue only when there is any", () => {
    expect(summaryParts({ dueToday: 3, overdue: 0, completedToday: 2 } as Briefing["stats"]).map((p) => p.key)).toEqual(["home.summary.due", "home.summary.done"]);
    expect(summaryParts({ dueToday: 3, overdue: 1, completedToday: 2 } as Briefing["stats"]).map((p) => p.vars?.count)).toEqual(["3", "1", "2"]);
  });
});

describe("Next up: then …", () => {
  it("the next open task that isn't Next up; done ones are skipped", () => {
    const b = { nextUp: task("a"), today: today([task("a"), task("b", { status: "COMPLETED" }), task("c", { dueTime: "4:00 PM" })]) };
    expect(thenUp(b)).toEqual({ title: "Task c", time: "4:00 PM" });
  });
  it("no other task: the first pending routine with a time; nothing: null", () => {
    expect(thenUp({ nextUp: task("a"), today: today([task("a")], [routine("r1", "COMPLETED"), routine("r2", "PENDING", null), routine("r3", "PENDING")]) })).toEqual({ title: "Routine r3", time: "7:00 PM" });
    expect(thenUp({ nextUp: task("a"), today: today([task("a")]) })).toBeNull();
  });
});

describe("quick-access tile captions", () => {
  it("routines: left today, all done, or the plain label when there are none", () => {
    expect(routinesCaption([routine("1", "PENDING"), routine("2", "COMPLETED"), routine("3", "PENDING")])).toEqual({ key: "home.tiles.routinesLeft", vars: { count: "2" } });
    expect(routinesCaption([routine("1", "COMPLETED")])).toEqual({ key: "home.tiles.routinesDone" });
    expect(routinesCaption([])).toBeNull();
  });
  it("mood: check in while due or never logged, else the latest mood", () => {
    expect(moodCaption({ latest: null, checkinDue: false }).key).toBe("home.tiles.moodCheckin");
    expect(moodCaption({ latest: { mood: "calm", score: 7, at: "x" }, checkinDue: true }).key).toBe("home.tiles.moodCheckin");
    expect(moodCaption({ latest: { mood: "calm", score: 7, at: "x" }, checkinDue: false })).toEqual({ key: "home.tiles.moodLatest", vars: { mood: "calm" } });
  });
});

describe("Snooze 1 h on Next up", () => {
  it("fires in an hour and replaces an earlier snooze of the same task", () => {
    const t0 = Date.parse("2040-03-05T09:00:00.000Z");
    const base = { taskId: "t1", title: "Reminder", body: "Essay", data: { taskId: "t1" }, categoryIdentifier: "lo-task" };
    const once = addTaskSnooze(addTaskSnooze([], base, t0), base, t0, NEXT_UP_SNOOZE_MINUTES);
    expect(once.map((s) => s.fireAt)).toEqual([new Date(t0 + 3600000).toISOString()]);
  });
});

describe("evening order", () => {
  it("evening from 18:00 local time", () => {
    expect(isEvening(new Date(2026, 10, 12, 17, 59))).toBe(false);
    expect(isEvening(new Date(2026, 10, 12, 18, 0))).toBe(true);
    expect(isEvening(new Date(2026, 10, 12, 23, 30))).toBe(true);
  });
  it("tomorrow preview: open top-level tasks for tomorrow, earliest first, max 3", () => {
    const now = new Date(2026, 10, 12, 19, 0);
    const iso = (d: number, h: number) => new Date(2026, 10, d, h, 0).toISOString();
    const tasks = [
      task("late", { dueAt: iso(13, 17) }),
      task("early", { dueAt: iso(13, 9) }),
      task("planned", { scheduledStart: iso(13, 11), dueAt: iso(20, 9) }),
      task("done", { dueAt: iso(13, 8), status: "COMPLETED" }),
      task("sub", { dueAt: iso(13, 8), parentTaskId: "late" }),
      task("today", { dueAt: iso(12, 21) }),
      task("extra", { dueAt: iso(13, 20) }),
    ];
    expect(tomorrowPreview(tasks, now).map((t) => t.id)).toEqual(["early", "planned", "late"]);
  });
});
