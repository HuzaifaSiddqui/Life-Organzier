import { describe, expect, it } from "vitest";
import { addTaskSnooze, liveTaskSnoozes, withoutTask } from "../taskSnooze";

// Pinned clock: the user taps "Snooze 15 min" at 9:00.
const T0 = new Date("2040-03-05T09:00:00.000Z").getTime();
const min = (m: number) => T0 + m * 60000;
const snoozed = addTaskSnooze([], { taskId: "t1", title: "Essay", body: "Due 5 PM", data: { taskId: "t1", kind: "lo-reminder" }, categoryIdentifier: "lo-task" }, T0);

describe("task snooze survives a re-sync", () => {
  it("re-syncs at +1 min and +14 min schedule it again for +15, under the same identifier", () => {
    for (const at of [min(1), min(14)]) {
      const live = liveTaskSnoozes(snoozed, new Set(["t1"]), at);
      expect(live.map((s) => [s.identifier, s.fireAt])).toEqual([["snooze:t:t1", new Date(min(15)).toISOString()]]);
    }
  });
  it("after it fired (+16) it is not scheduled again", () => {
    expect(liveTaskSnoozes(snoozed, new Set(["t1"]), min(16))).toEqual([]);
  });
  it("a task done or deleted meanwhile drops it; an unreadable task list keeps it", () => {
    expect(liveTaskSnoozes(snoozed, new Set(["other"]), min(1))).toEqual([]);
    expect(liveTaskSnoozes(snoozed, null, min(1))).toHaveLength(1);
    expect(withoutTask(snoozed, "t1")).toEqual([]);
  });
  it("snoozing again replaces the earlier snooze", () => {
    const again = addTaskSnooze(snoozed, { taskId: "t1", title: "Essay", body: "Due 5 PM", data: {}, categoryIdentifier: "lo-task" }, min(15));
    expect(again.map((s) => s.fireAt)).toEqual([new Date(min(30)).toISOString()]);
  });
});
