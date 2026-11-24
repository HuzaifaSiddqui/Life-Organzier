import { describe, expect, it } from "vitest";
import { remindersOutdated, taskReminderIdentifiers } from "../taskReminders";

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

describe("remindersOutdated", () => {
  const before = { status: "PENDING", dueAt: "2026-11-24T16:00:00.000Z", scheduledStart: "2026-11-24T13:00:00.000Z", scheduledEnd: "2026-11-24T14:00:00.000Z" };

  it("done, skipped or deleted", () => {
    for (const status of ["COMPLETED", "SKIPPED", "DELETED"]) expect(remindersOutdated(before, { ...before, status })).toBe(true);
  });

  it("moved: deadline, planned start or planned end", () => {
    expect(remindersOutdated(before, { ...before, dueAt: "2026-11-25T16:00:00.000Z" })).toBe(true);
    expect(remindersOutdated(before, { ...before, dueAt: null })).toBe(true);
    expect(remindersOutdated(before, { ...before, scheduledStart: "2026-11-24T13:30:00.000Z" })).toBe(true);
    expect(remindersOutdated(before, { ...before, scheduledEnd: null })).toBe(true);
    expect(remindersOutdated({ status: "PENDING", dueAt: null }, { status: "PENDING", dueAt: "2026-11-24T16:00:00.000Z" })).toBe(true);
  });

  it("other edits and the same instant in another format are not a move", () => {
    expect(remindersOutdated(before, { ...before })).toBe(false);
    expect(remindersOutdated(before, { ...before, status: "IN_PROGRESS" })).toBe(false);
    // 21:00 in Pakistan (UTC+5) is 16:00 UTC: same instant, written differently.
    expect(remindersOutdated(before, { ...before, dueAt: "2026-11-24T21:00:00+05:00" })).toBe(false);
    expect(remindersOutdated({ status: "PENDING" }, { status: "PENDING", dueAt: null, scheduledStart: undefined })).toBe(false);
  });

  it("reopening a done task (undo) does not cancel; the sync re-makes its reminders", () => {
    expect(remindersOutdated({ ...before, status: "COMPLETED" }, { ...before, status: "PENDING" })).toBe(false);
  });
});
