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
  completionBufferMinutes,
  planTaskCheckins,
  requestExtraCheckin,
  type CheckinHistory,
} from "../src/modules/checkins/checkinPlanner.js";
import { createTask, updateTask } from "../src/modules/tasks/taskService.js";
import { settings, task, TZ } from "./fixtures.js";

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
    { kind: "START", fireAt: at(16, 5), status: "IGNORED", response: null },
    { kind: "START_FOLLOWUP", fireAt: at(16, 30), status: "SCHEDULED", response: null },
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
  assert.deepEqual(checkinEligibility(physics({ taskType: TaskType.DEADLINE }), s, now), { start: false, completion: false });
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
  assert.deepEqual(plan(physics(), at(16, 6), [{ kind: "START", fireAt: at(16, 5), status: "ANSWERED", response: "NOT_TODAY" }]), []);
  assert.deepEqual(plan(physics({ status: TaskStatus.IN_PROGRESS, startedAt: at(16, 7) }), at(18, 20), [{ kind: "COMPLETION", fireAt: at(18, 19), status: "ANSWERED", response: "DONE" }]), []);
});

test("check-ins: per-task cap of 3 counts check-ins that already fired", () => {
  const fired: CheckinHistory[] = [
    { kind: "START", fireAt: at(10, 5), status: "IGNORED", response: null },
    { kind: "START_FOLLOWUP", fireAt: at(10, 30), status: "IGNORED", response: null },
    { kind: "COMPLETION", fireAt: at(11, 0), status: "IGNORED", response: null },
  ];
  // Rescheduled to 16:00 after three check-ins already fired → nothing more.
  assert.deepEqual(plan(physics(), at(12), fired), []);
});

test("check-ins: daily cap of 5 across tasks, soonest first", () => {
  const items = [9, 10, 11, 12, 13, 14, 15].map((h) => ({ id: h, fireAt: at(h) }));
  assert.deepEqual(applyDailyCap(items, TZ).map((c) => c.id), [9, 10, 11, 12, 13]);
  assert.deepEqual(applyDailyCap(items, TZ, new Map([["2026-10-05", 4]])).map((c) => c.id), [9]);
  const twoDays = [...items.slice(0, 5), { id: 99, fireAt: at(9, 0, "2026-10-06") }];
  assert.ok(applyDailyCap(twoDays, TZ, new Map([["2026-10-05", 5]])).some((c) => c.id === 99));
});

test("check-ins: user-requested extra time is exempt from caps but limited to 2 per task", () => {
  const s = settings();
  const t = { dueAt: at(23, 59, "2026-10-09") };
  const capped: CheckinHistory[] = ["START", "START_FOLLOWUP", "COMPLETION"].map((kind) => ({ kind, fireAt: at(10), status: "IGNORED", response: null }));
  const r1 = requestExtraCheckin(30, t, s, TZ, at(18, 20), null, capped);
  assert.ok(r1.ok && hm(r1.fireAt) === "18:50" && !r1.passesDeadline);
  const two: CheckinHistory[] = [1, 2].map((i) => ({ kind: "COMPLETION_EXTRA", fireAt: at(18, i), status: "ANSWERED", response: "PLUS_30" }));
  assert.deepEqual(requestExtraCheckin(30, t, s, TZ, at(18, 20), null, two), { ok: false, reason: "limit" });
  assert.deepEqual(requestExtraCheckin(60, t, s, TZ, at(21, 30), null, []), { ok: false, reason: "quiet_hours" });
  assert.deepEqual(requestExtraCheckin(15, t, s, TZ, at(18), at(19), []), { ok: false, reason: "dnd" });
});

test("check-ins: +30 min past the deadline is flagged", () => {
  const r = requestExtraCheckin(30, { dueAt: at(18, 30) }, settings(), TZ, at(18, 20), null, []);
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

const dbAvailable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

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

test.after(() => prisma.$disconnect());
