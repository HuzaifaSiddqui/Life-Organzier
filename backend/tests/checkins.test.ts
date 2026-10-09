import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Priority, TaskSource, TaskStatus, TaskType } from "@prisma/client";
import { prisma } from "../src/config/db.js";
import { localParts, zonedTimeToUtc } from "../src/lib/time.js";
import {
  applyDailyCap,
  checkinEligibility,
  chooseTone,
  completionBase,
  completionBufferMinutes,
  planTaskCheckins,
  requestExtraCheckin,
  rescheduledAfterStart,
  type CheckinHistory,
} from "../src/modules/checkins/checkinPlanner.js";
import { createTask, updateTask } from "../src/modules/tasks/taskService.js";
import { settings, task, TZ, dbAvailable } from "./fixtures.js";

// Monday 2026-10-05, Karachi. Quiet hours 22:00–08:00 (fixture default).
const at = (h: number, m = 0, ymd = "2026-10-05") => zonedTimeToUtc(ymd, h, m, TZ);
const hm = (d: Date) => `${localParts(d, TZ).h}:${String(localParts(d, TZ).mi).padStart(2, "0")}`;
const physics = (o = {}) =>
  task({ title: "Physics assignment", taskType: TaskType.FLEXIBLE, scheduledStart: at(16), durationMinutes: 120, dueAt: at(23, 59, "2026-10-09"), dueTime: "11:59 PM", ...o });
const plan = (t = physics(), now = at(12), history: CheckinHistory[] = [], s = settings()) =>
  planTaskCheckins(t, s, TZ, now, null, history).map((c) => `${c.kind} ${hm(c.fireAt)}${c.unconfirmed ? " ?" : ""}`);

test("check-ins: flexible task gets start at +5 and completion after duration + buffer", () => {
  assert.deepEqual(plan(), ["START 16:05 ?", "START_FOLLOWUP 16:30 ?", "COMPLETION 18:12 ?"]);
  // Started at 16:07 → no start check-ins, completion 16:07 + 2h + 12 min.
  assert.deepEqual(plan(physics({ status: TaskStatus.IN_PROGRESS, startedAt: at(16, 7) }), at(16, 7)), ["COMPLETION 18:19"]);
  assert.equal(completionBufferMinutes(120), 12);
  assert.equal(completionBufferMinutes(30), 10);
});

test("check-ins: one follow-up when the start goes unanswered, then no more start check-ins", () => {
  const fired: CheckinHistory[] = [
    { kind: "START", fireAt: at(16, 5), slotStart: at(16), status: "IGNORED", response: null },
    { kind: "START_FOLLOWUP", fireAt: at(16, 30), slotStart: at(16), status: "SCHEDULED", response: null },
  ];
  assert.deepEqual(plan(physics(), at(16, 31), fired), ["COMPLETION 18:12 ?"]);
});

test("check-ins: a start inside quiet hours or DND is skipped, not moved", () => {
  const late = physics({ scheduledStart: at(22, 30), durationMinutes: 30 });
  assert.deepEqual(plan(late), []);
  const dnd = planTaskCheckins(physics(), settings(), TZ, at(12), at(17), []).map((c) => c.kind);
  assert.deepEqual(dnd, ["COMPLETION"]);
});

test("check-ins: eligibility rules", () => {
  const s = settings();
  const now = at(12);
  assert.deepEqual(checkinEligibility(physics({ taskType: TaskType.FIXED }), s, now), { start: false, completion: false });
  // DEADLINE qualifies with a work block (scheduledStart) and a duration; without a duration it doesn't.
  assert.deepEqual(checkinEligibility(physics({ taskType: TaskType.DEADLINE }), s, now), { start: true, completion: true });
  assert.deepEqual(checkinEligibility(physics({ taskType: TaskType.DEADLINE, durationMinutes: null }), s, now), { start: false, completion: false });
  assert.deepEqual(checkinEligibility(physics({ taskType: TaskType.DEADLINE, scheduledStart: null }), s, now), { start: false, completion: false });
  assert.deepEqual(checkinEligibility(physics({ scheduledStart: null }), s, now), { start: false, completion: false });
  assert.deepEqual(checkinEligibility(physics({ status: TaskStatus.COMPLETED }), s, now), { start: false, completion: false });
  assert.deepEqual(checkinEligibility(physics({ archived: true }), s, now), { start: false, completion: false });
  assert.deepEqual(checkinEligibility(physics({ dueAt: at(11) }), s, now), { start: false, completion: false }, "passed deadline → overdue flow");
  assert.deepEqual(checkinEligibility(physics(), settings({ checkinsEnabled: false }), now), { start: false, completion: false });
  assert.deepEqual(checkinEligibility(physics(), settings({ notificationFrequency: "NONE" }), now), { start: false, completion: false });
  assert.deepEqual(checkinEligibility(physics({ durationMinutes: null }), s, now), { start: true, completion: false });
  assert.deepEqual(checkinEligibility(physics({ taskType: TaskType.DURATION }), s, now), { start: true, completion: true });
});

test("check-ins: answered or declined check-ins end the sequence", () => {
  assert.deepEqual(plan(physics(), at(16, 6), [{ kind: "START", fireAt: at(16, 5), slotStart: at(16), status: "ANSWERED", response: "NOT_TODAY" }]), []);
  assert.deepEqual(plan(physics({ status: TaskStatus.IN_PROGRESS, startedAt: at(16, 7) }), at(18, 20), [{ kind: "COMPLETION", fireAt: at(18, 19), slotStart: at(16), status: "ANSWERED", response: "DONE" }]), []);
});

test("check-ins: per-task cap of 3 counts check-ins that already fired for the slot", () => {
  const fired: CheckinHistory[] = [
    { kind: "START", fireAt: at(16, 5), slotStart: at(16), status: "IGNORED", response: null },
    { kind: "START_FOLLOWUP", fireAt: at(16, 30), slotStart: at(16), status: "IGNORED", response: null },
    { kind: "COMPLETION_EXTRA", fireAt: at(16, 40), slotStart: at(16), status: "ANSWERED", response: "PLUS_30" },
  ];
  // Two planned ones fired (the extra doesn't count) → only the completion is left.
  assert.deepEqual(plan(physics(), at(16, 41), fired), ["COMPLETION 18:12 ?"]);
  const three: CheckinHistory[] = [...fired.slice(0, 2), { kind: "COMPLETION", fireAt: at(16, 35), slotStart: at(16), status: "IGNORED", response: null }];
  assert.deepEqual(plan(physics({ durationMinutes: 180 }), at(16, 41), three), []);
});

test("check-ins: history only counts for the current slot (rescheduled tasks start fresh)", () => {
  // "Not today" on Monday's 16:00 slot, then rescheduled to Tuesday 16:00.
  const notToday: CheckinHistory[] = [{ kind: "START", fireAt: at(16, 5), slotStart: at(16), status: "ANSWERED", response: "NOT_TODAY" }];
  assert.deepEqual(plan(physics(), at(16, 6), notToday), []);
  const tuesday = physics({ scheduledStart: at(16, 0, "2026-10-06") });
  assert.deepEqual(plan(tuesday, at(16, 6), notToday), ["START 16:05 ?", "START_FOLLOWUP 16:30 ?", "COMPLETION 18:12 ?"]);

  // Partly done at the completion check-in, then the rest is booked for 19:00 the same day.
  const partly: CheckinHistory[] = [{ kind: "COMPLETION", fireAt: at(18, 19), slotStart: at(16), status: "ANSWERED", response: "PARTIAL_50" }];
  const started = { status: TaskStatus.IN_PROGRESS, startedAt: at(16, 7), progress: 50 };
  assert.deepEqual(plan(physics({ ...started }), at(18, 20), partly), []);
  assert.deepEqual(plan(physics({ ...started, scheduledStart: at(19), durationMinutes: 60 }), at(18, 20), partly), ["COMPLETION 20:10"]);
});

test("check-ins: short tasks drop the follow-up when it would land at or near completion", () => {
  assert.deepEqual(plan(physics({ durationMinutes: 15 })), ["START 16:05 ?", "COMPLETION 16:25 ?"]);
  assert.deepEqual(plan(physics({ durationMinutes: 20 })), ["START 16:05 ?", "COMPLETION 16:30 ?"]);
  assert.deepEqual(plan(physics({ durationMinutes: 30 })), ["START 16:05 ?", "COMPLETION 16:40 ?"]);
  assert.deepEqual(plan(physics({ durationMinutes: 45 })), ["START 16:05 ?", "START_FOLLOWUP 16:30 ?", "COMPLETION 16:55 ?"]);
});

test("check-ins: planned check-ins after the deadline are dropped", () => {
  assert.deepEqual(plan(physics({ dueAt: at(17), dueTime: "5 PM" })), ["START 16:05 ?", "START_FOLLOWUP 16:30 ?"]);
});

test("check-ins: daily cap of 5 across tasks, soonest first", () => {
  const items = [9, 10, 11, 12, 13, 14, 15].map((h) => ({ id: h, kind: "START", fireAt: at(h) }));
  assert.deepEqual(applyDailyCap(items, TZ).map((c) => c.id), [9, 10, 11, 12, 13]);
  assert.deepEqual(applyDailyCap(items, TZ, new Map([["2026-10-05", 4]])).map((c) => c.id), [9]);
  const twoDays = [...items.slice(0, 5), { id: 99, kind: "START", fireAt: at(9, 0, "2026-10-06") }];
  assert.ok(applyDailyCap(twoDays, TZ, new Map([["2026-10-05", 5]])).some((c) => c.id === 99));
});

test("check-ins: over the daily cap, start follow-ups are dropped before a later completion", () => {
  const items = [
    { id: "a-start", kind: "START", fireAt: at(9, 5) },
    { id: "a-follow", kind: "START_FOLLOWUP", fireAt: at(9, 30) },
    { id: "b-start", kind: "START", fireAt: at(10, 5) },
    { id: "b-follow", kind: "START_FOLLOWUP", fireAt: at(10, 30) },
    { id: "c-start", kind: "START", fireAt: at(11, 5) },
    { id: "a-done", kind: "COMPLETION", fireAt: at(17, 0) },
  ];
  // Soonest-first alone would keep both follow-ups and push out the 17:00 completion.
  assert.deepEqual(applyDailyCap(items, TZ).map((c) => c.id), ["a-start", "a-follow", "b-start", "c-start", "a-done"]);
  assert.deepEqual(applyDailyCap(items, TZ, new Map([["2026-10-05", 1]])).map((c) => c.id), ["a-start", "b-start", "c-start", "a-done"]);
});

test("check-ins: rescheduled after starting → completion counts from the new start", () => {
  const moved = physics({ status: TaskStatus.IN_PROGRESS, startedAt: at(10), scheduledStart: at(16) });
  assert.equal(rescheduledAfterStart(moved), true);
  assert.equal(completionBase(moved).getTime(), at(16).getTime());
  assert.deepEqual(plan(moved, at(12)), ["COMPLETION 18:12"]);
  const normal = physics({ status: TaskStatus.IN_PROGRESS, startedAt: at(16, 7) });
  assert.equal(rescheduledAfterStart(normal), false);
  assert.equal(completionBase(normal).getTime(), at(16, 7).getTime());
});

test("check-ins: user-requested extra time is exempt from caps but limited to 2 per slot", () => {
  const s = settings();
  const t = { dueAt: at(23, 59, "2026-10-09"), scheduledStart: at(16) };
  const capped: CheckinHistory[] = ["START", "START_FOLLOWUP", "COMPLETION"].map((kind) => ({ kind, fireAt: at(10), slotStart: at(16), status: "IGNORED", response: null }));
  const r1 = requestExtraCheckin(30, t, s, TZ, at(18, 20), null, capped);
  assert.ok(r1.ok && hm(r1.fireAt) === "18:50" && !r1.passesDeadline);
  const two: CheckinHistory[] = [1, 2].map((i) => ({ kind: "COMPLETION_EXTRA", fireAt: at(18, i), slotStart: at(16), status: "ANSWERED", response: "PLUS_30" }));
  assert.deepEqual(requestExtraCheckin(30, t, s, TZ, at(18, 20), null, two), { ok: false, reason: "limit" });
  // Rescheduled to a new slot: the two extras from the old slot no longer count.
  const moved = { ...t, scheduledStart: at(19) };
  assert.ok(requestExtraCheckin(30, moved, s, TZ, at(20, 30), null, two).ok);
  assert.deepEqual(requestExtraCheckin(60, t, s, TZ, at(21, 30), null, []), { ok: false, reason: "quiet_hours" });
  assert.deepEqual(requestExtraCheckin(15, t, s, TZ, at(18), at(19), []), { ok: false, reason: "dnd" });
});

test("check-ins: +30 min past the deadline is flagged", () => {
  const r = requestExtraCheckin(30, { dueAt: at(18, 30), scheduledStart: at(16) }, settings(), TZ, at(18, 20), null, []);
  assert.ok(r.ok && r.passesDeadline);
});

test("check-ins: tone is the saved style (Funny by default) except Gentle after a hard mood", () => {
  const now = at(16);
  assert.deepEqual(chooseTone(settings().checkinTone, null, now), { tone: "FUNNY", offerSplit: false });
  assert.deepEqual(chooseTone("SERIOUS", null, now), { tone: "SERIOUS", offerSplit: false });
  assert.deepEqual(chooseTone("bogus", null, now), { tone: "FUNNY", offerSplit: false });
  const overwhelmed = { mood: "overwhelmed", createdAt: at(13) };
  assert.deepEqual(chooseTone("FUNNY", overwhelmed, now), { tone: "GENTLE", offerSplit: true });
  assert.deepEqual(chooseTone("FUNNY", { mood: "sad", createdAt: at(15, 0, "2026-10-04") }, now), { tone: "FUNNY", offerSplit: false }, "older than 24 h");
  assert.deepEqual(chooseTone("SERIOUS", { mood: "happy", createdAt: at(15) }, now), { tone: "SERIOUS", offerSplit: false });
});

test("check-ins: startedAt is recorded on the first move to IN_PROGRESS only", { skip: !dbAvailable && "no database" }, async () => {
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `checkin-${randomUUID()}@example.test` } });
  try {
    const ctx = { userId: user.id, tz: TZ };
    const t = await createTask(ctx, { title: "Essay", priority: Priority.MEDIUM, source: TaskSource.MANUAL });
    assert.equal(t.startedAt, null);
    const started = await updateTask(ctx, t.id, { status: TaskStatus.IN_PROGRESS });
    assert.ok(started?.startedAt);
    await updateTask(ctx, t.id, { status: TaskStatus.PENDING });
    const again = await updateTask(ctx, t.id, { status: TaskStatus.IN_PROGRESS });
    assert.equal(again?.startedAt?.getTime(), started.startedAt.getTime());
    const viaProgress = await createTask(ctx, { title: "Slides", priority: Priority.MEDIUM, source: TaskSource.MANUAL });
    assert.ok((await updateTask(ctx, viaProgress.id, { progress: 40 }))?.startedAt);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test("check-ins: logs survive task deletion (taskId → null) and go with the user", { skip: !dbAvailable && "no database" }, async () => {
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `checkin-log-${randomUUID()}@example.test` } });
  let logId = "";
  try {
    const t = await createTask({ userId: user.id, tz: TZ }, { title: "Essay", priority: Priority.MEDIUM, source: TaskSource.MANUAL });
    const log = await prisma.checkinLog.create({
      data: { userId: user.id, taskId: t.id, slotStart: at(16), kind: "START", fireAt: at(16, 5), tone: "FUNNY", copySource: "TEMPLATE", message: "Started?" },
    });
    logId = log.id;
    await prisma.task.delete({ where: { id: t.id } });
    const kept = await prisma.checkinLog.findUnique({ where: { id: logId } });
    assert.ok(kept);
    assert.equal(kept.taskId, null);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
  assert.equal(await prisma.checkinLog.findUnique({ where: { id: logId } }), null);
});

test.after(() => prisma.$disconnect());
