import { describe, expect, it } from "vitest";
import type { Task } from "../../types/models";
import { taskEvent } from "../calendarSync";
import { mergeStatusProgress, undoStatusChanges } from "../taskUndo";

/** Swipe "Done" (toggle) then Undo, through the same local rule the phone applies. */
const swipeThenUndo = (t: Task) => {
  const swiped = { ...t, ...mergeStatusProgress(t, { status: t.status === "COMPLETED" ? "PENDING" : "COMPLETED" }) };
  return { swiped, undone: { ...swiped, ...mergeStatusProgress(swiped, undoStatusChanges(t)) } };
};
const task = (over: Partial<Task>) =>
  ({ id: "t1", title: "Physics report", status: "PENDING", progress: 0, dueDate: "2026-11-13T00:00:00.000Z", dueTime: "3:00 PM", dueAt: "2026-11-13T10:00:00.000Z", scheduledStart: null, scheduledEnd: null, durationMinutes: null, archived: false, ...over }) as Task;

describe("swipe Undo restores the exact previous status and progress", () => {
  it("never started (0 %) → Done → Undo: open at 0 %, not 75 %", () => {
    const { swiped, undone } = swipeThenUndo(task({}));
    expect([swiped.status, swiped.progress]).toEqual(["COMPLETED", 100]);
    expect([undone.status, undone.progress]).toEqual(["PENDING", 0]);
  });
  it("in progress at 40 % → Done → Undo: in progress at 40 %", () => {
    const { undone } = swipeThenUndo(task({ status: "IN_PROGRESS", progress: 40 }));
    expect([undone.status, undone.progress]).toEqual(["IN_PROGRESS", 40]);
  });
  it("done → swipe reopens → Undo: done at 100 % again", () => {
    const { swiped, undone } = swipeThenUndo(task({ status: "COMPLETED", progress: 100 }));
    expect(swiped.status).toBe("PENDING");
    expect([undone.status, undone.progress]).toEqual(["COMPLETED", 100]);
  });
  it("the calendar event (with or without the ✓ mark) is exactly what it was", () => {
    for (const t of [task({}), task({ status: "COMPLETED", progress: 100 })]) {
      const { swiped, undone } = swipeThenUndo(t);
      expect(taskEvent(swiped)?.title).not.toBe(taskEvent(t)?.title);
      expect(taskEvent(undone)).toEqual(taskEvent(t));
    }
  });
});
