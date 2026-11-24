import { describe, expect, it } from "vitest";
import {
  CANCELLED_KEEP_MS,
  calendarDay,
  cancelledToClear,
  clockMinutes,
  pendingTaskIds,
  remindersOutdated,
  suppressedTasks,
  taskReminderIdentifiers,
} from "../taskReminders";

const n = (identifier: string, data: Record<string, unknown> | null) => ({ identifier, content: { data } });

describe("taskReminderIdentifiers", () => {
  const scheduled = [
    n("lo:t:task-1:29000001", { kind: "lo-reminder", taskId: "task-1", routineOccurrenceId: null }),
    n("lo:t:task-1:29000060", { kind: "lo-reminder", taskId: "task-1", routineOccurrenceId: null }),
    n("lo:snooze:t:task-1", { kind: "lo-reminder", taskId: "task-1" }),
    n("lo:t:task-2:29000001", { kind: "lo-reminder", taskId: "task-2" }),
    // Not task reminders: a check-in for the same task, a routine, a location alert, someone else's notification.
    n("lo:c:checkin-9", { kind: "lo-checkin", taskId: "task-1", checkinId: "checkin-9" }),
    n("lo:r:occ-3:time", { kind: "lo-reminder", taskId: null, routineOccurrenceId: "occ-3" }),
    n("lo:rs:occ-3", { kind: "lo-reminder", taskId: null, routineOccurrenceId: "occ-3" }),
    n("lo-loc:place-1:1700000000000", { kind: "lo-location", taskIds: ["task-1"] }),
    n("other:task-1", { kind: "lo-reminder", taskId: "task-1" }),
    n("lo:odd", null),
  ];

  it("picks the task's planned reminders and its snooze only", () => {
    expect(taskReminderIdentifiers(scheduled, "task-1")).toEqual(["lo:t:task-1:29000001", "lo:t:task-1:29000060", "lo:snooze:t:task-1"]);
  });

  it("leaves check-ins, routines, location alerts and other tasks alone", () => {
    const picked = taskReminderIdentifiers(scheduled, "task-1");
    for (const id of ["lo:c:checkin-9", "lo:r:occ-3:time", "lo:rs:occ-3", "lo-loc:place-1:1700000000000", "other:task-1", "lo:t:task-2:29000001"]) {
      expect(picked).not.toContain(id);
    }
    expect(taskReminderIdentifiers(scheduled, "missing")).toEqual([]);
  });
});

const KHI = "Asia/Karachi";
const LON = "Europe/London";

// A task due Tue 24 Nov 2026, 9 PM in Karachi (16:00 UTC), planned 6–7 PM there; stored as the server has it.
const stored = {
  status: "PENDING",
  dueDate: "2026-11-23T19:00:00.000Z", // local midnight, Karachi (the form's date picker)
  dueTime: "9:00 PM",
  dueAt: "2026-11-24T16:00:00.000Z",
  scheduledStart: "2026-11-24T13:00:00.000Z",
  scheduledEnd: "2026-11-24T14:00:00.000Z",
};

describe("calendarDay and clockMinutes", () => {
  it("local midnight and UTC noon are the same day", () => {
    expect(calendarDay("2026-11-23T19:00:00.000Z", KHI)).toBe("2026-11-24");
    expect(calendarDay("2026-11-24T12:00:00.000Z", KHI)).toBe("2026-11-24");
    expect(calendarDay("2026-11-24T12:00:00.000Z", LON)).toBe("2026-11-24");
    expect(calendarDay(null)).toBeNull();
  });

  it('"9:00 PM", "9 pm" and "21:00" are the same time', () => {
    expect(clockMinutes("9:00 PM")).toBe(21 * 60);
    expect(clockMinutes("9 pm")).toBe(21 * 60);
    expect(clockMinutes("21:00")).toBe(21 * 60);
    expect(clockMinutes("12:30 AM")).toBe(30);
    expect(clockMinutes(null)).toBeNull();
  });
});

describe("remindersOutdated (a move needs both checks)", () => {
  it("done, skipped or deleted", () => {
    for (const status of ["COMPLETED", "SKIPPED", "DELETED"]) expect(remindersOutdated(stored, { ...stored, status }, KHI)).toBe(true);
  });

  it("an unchanged save on a phone in another time zone is not a move", () => {
    // A phone in London: the form reads the stored day in the phone's zone (Karachi midnight 24 Nov = 19:00 UTC on
    // 23 Nov, so it shows 23 Nov), writes London midnight of that day back, and recomputes dueAt in London (9 PM =
    // 21:00 UTC). A different moment, but the same normalised fields, so not a move.
    const save = { ...stored, dueDate: "2026-11-23T00:00:00.000Z", dueAt: "2026-11-23T21:00:00.000Z" };
    expect(remindersOutdated(stored, save, LON)).toBe(false);
  });

  it("a chat-made task saved from the form unchanged is not a move", () => {
    const chat = { ...stored, dueDate: "2026-11-24T12:00:00.000Z", dueTime: "21:00" }; // parser: UTC noon, 24-hour
    const form = { ...stored, dueDate: "2026-11-23T19:00:00.000Z", dueTime: "9:00 PM" };
    expect(remindersOutdated(chat, form, KHI)).toBe(false);
  });

  it('"9:00 PM" vs "21:00" alone is not a move', () => {
    expect(remindersOutdated({ ...stored, dueTime: "21:00" }, { ...stored, dueTime: "9:00 PM" }, KHI)).toBe(false);
  });

  it("a real date change is a move", () => {
    expect(remindersOutdated(stored, { ...stored, dueDate: "2026-11-24T19:00:00.000Z", dueAt: "2026-11-25T16:00:00.000Z" }, KHI)).toBe(true);
  });

  it("a real time change is a move", () => {
    expect(remindersOutdated(stored, { ...stored, dueTime: "10:00 PM", dueAt: "2026-11-24T17:00:00.000Z" }, KHI)).toBe(true);
  });

  it("a real planned start change is a move (minute precision)", () => {
    expect(remindersOutdated(stored, { ...stored, scheduledStart: "2026-11-24T13:30:00.000Z" }, KHI)).toBe(true);
    // Seconds the form drops are not a move.
    expect(remindersOutdated({ ...stored, scheduledStart: "2026-11-24T13:00:27.000Z" }, stored, KHI)).toBe(false);
  });

  it("other edits are not a move, and reopening does not cancel", () => {
    expect(remindersOutdated(stored, { ...stored, status: "IN_PROGRESS" }, KHI)).toBe(false);
    expect(remindersOutdated({ ...stored, status: "COMPLETED" }, stored, KHI)).toBe(false);
  });
});

describe("cancelled tasks", () => {
  const T0 = Date.UTC(2026, 10, 24, 12, 0, 0);
  const base = { now: T0 + 5000, planRequestedAt: null as number | null, pending: new Set<string>(), existing: new Set(["task-1", "task-2"]) as Set<string> | null };

  it("Done during a running sync: a plan asked for before the cancel is not trusted", () => {
    // The sync asked for its plan at T0; Done was tapped at T0 + 1 s, while the plan was on its way.
    const all = { "task-1": T0 + 1000 };
    const ctx = { ...base, planRequestedAt: T0 };
    expect(cancelledToClear(all, ctx)).toEqual([]);
    expect([...suppressedTasks(all, ctx)]).toEqual(["task-1"]);
  });

  it("not trusted while the change is still queued, even for a newer plan", () => {
    const all = { "task-1": T0 };
    const ctx = { ...base, planRequestedAt: T0 + 2000, pending: pendingTaskIds([{ taskId: "task-1" }]) };
    expect(cancelledToClear(all, ctx)).toEqual([]);
  });

  it("a moved task gets its new reminders from the first trusted plan", () => {
    const all = { "task-1": T0 };
    const ctx = { ...base, planRequestedAt: T0 + 2000 }; // asked for after the move, nothing queued
    expect(cancelledToClear(all, ctx)).toEqual(["task-1"]);
    expect(suppressedTasks(all, ctx).size).toBe(0);
  });

  it("a stuck queue: the entry goes after 7 days", () => {
    const all = { "task-1": T0 };
    const stuck = { ...base, pending: new Set(["task-1"]), planRequestedAt: T0 + 2000 };
    expect(cancelledToClear(all, { ...stuck, now: T0 + CANCELLED_KEEP_MS - 1 })).toEqual([]);
    expect(cancelledToClear(all, { ...stuck, now: T0 + CANCELLED_KEEP_MS })).toEqual(["task-1"]);
  });

  it("a deleted task no longer on the phone: the entry goes", () => {
    const all = { "task-gone": T0 };
    expect(cancelledToClear(all, { ...base, pending: new Set(["task-gone"]) })).toEqual(["task-gone"]);
    // The task list can't be read: keep it.
    expect(cancelledToClear(all, { ...base, existing: null })).toEqual([]);
  });

  it("a task reopened offline stays without reminders until the next trusted plan", () => {
    // Done (cancelled), then Undo, all offline: the reopen is queued and no plan can be fetched.
    const all = { "task-2": T0 };
    const offline = { ...base, pending: pendingTaskIds([{ taskId: "task-2" }]) };
    expect([...suppressedTasks(all, offline)]).toEqual(["task-2"]);
    // Back online: the queue is sent, then a plan is asked for. Its reminders come back.
    expect(cancelledToClear(all, { ...base, planRequestedAt: T0 + 60000 })).toEqual(["task-2"]);
  });

  it("an offline create is pending by its local id", () => {
    expect([...pendingTaskIds([{ localId: "local-1" }, { taskId: "task-3" }, {}])]).toEqual(["local-1", "task-3"]);
  });
});
