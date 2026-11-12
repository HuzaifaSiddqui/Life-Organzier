import assert from "node:assert/strict";
import test from "node:test";
import { TaskType } from "@prisma/client";
import { classifyTaskType } from "../src/modules/assistant/entities.js";
import { movableTasksOn, taskBlock, type ScheduleContext } from "../src/modules/scheduling/schedulingService.js";
import { NOW, settings, task, TZ } from "./fixtures.js";

const ctx = (tasks: ReturnType<typeof task>[]): ScheduleContext => ({ tz: TZ, settings: settings(), tasks, occurrences: [], peak: { windows: [], learned: false, confidence: 0 } });

test("fixed time: a manual planned slot is the task's block (the planner never suggests over it)", () => {
  const start = new Date(NOW.getTime() + 3 * 3600000);
  const t = task({ scheduledStart: start, scheduledEnd: new Date(start.getTime() + 30 * 60000), durationMinutes: null });
  assert.equal(taskBlock(t)?.start.getTime(), start.getTime());
});

test("fixed time: the scheduler never moves a fixed-time task", () => {
  const at = new Date(NOW.getTime() + 2 * 3600000);
  const fixed = task({ id: "fixed", taskType: TaskType.FIXED, dueAt: at, dueTime: "12:00 PM", durationMinutes: 60 });
  const flexible = task({ id: "flex", taskType: TaskType.FLEXIBLE, scheduledStart: at, scheduledEnd: new Date(at.getTime() + 3600000) });
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(at);
  assert.deepEqual(movableTasksOn(ctx([fixed, flexible]), ymd).map((t) => t.id), ["flex"]);
});

test("fixed time: meeting / appointment / class / exam words with a time are inferred as fixed", () => {
  const at = { durationMinutes: null, time: { h: 10, mi: 0 }, frequency: null } as unknown as Parameters<typeof classifyTaskType>[1];
  for (const t of ["Team meeting at 10", "Dentist appointment at 10", "Physics class at 10", "Maths exam at 10"]) assert.equal(classifyTaskType(t, at), TaskType.FIXED, t);
  assert.notEqual(classifyTaskType("Write the essay at 10", at), TaskType.FIXED);
});
