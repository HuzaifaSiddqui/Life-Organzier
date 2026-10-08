import assert from "node:assert/strict";
import test from "node:test";
import { localParts, localYmd, zonedTimeToUtc } from "../src/lib/time.js";
import { adaptivityFromLogs, placeTaskReminder, sequenceForTask, type Adaptivity, type Draft } from "../src/modules/reminders/reminderService.js";
import { NOW, settings, task, TZ } from "./fixtures.js";

// NOW = Monday 2026-10-05 10:00 Karachi; peak hour 9.
const at = (ymd: string, h: number, m = 0) => zonedTimeToUtc(ymd, h, m, TZ);
const label = (d: Draft) => `${localYmd(d.at, TZ)} ${localParts(d.at, TZ).h}:${String(localParts(d.at, TZ).mi).padStart(2, "0")} ${d.level}`;
const plan = (dueAt: Date, dueTime: string | null, adapt?: Adaptivity) =>
  sequenceForTask(task({ dueAt, dueTime, durationMinutes: 60 }), settings(), TZ, 9, adapt, NOW);

test("reminders: escalation depends on days left", () => {
  // 5 days left: gentle → normal → urgent → critical → 1h → on time
  assert.deepEqual(plan(at("2026-10-10", 18), "6 PM").map(label), [
    "2026-10-07 14:00 gentle",
    "2026-10-08 9:00 normal",
    "2026-10-09 10:00 urgent",
    "2026-10-10 9:00 critical",
    "2026-10-10 17:00 urgent",
    "2026-10-10 18:00 critical",
  ]);
  // 2 days left: no gentle nudge
  assert.deepEqual(plan(at("2026-10-07", 18), "6 PM").map((d) => d.level), ["normal", "urgent", "critical", "urgent", "critical"]);
  // Due today: the peak-hour critical already passed, so it moves to the latest useful start (due − duration − 2h).
  assert.deepEqual(plan(at("2026-10-05", 18), "6 PM").map(label), ["2026-10-05 15:00 critical", "2026-10-05 17:00 urgent", "2026-10-05 18:00 critical"]);
  // Date-only deadline: no "due now" reminder.
  assert.equal(plan(at("2026-10-07", 23, 59), null).some((d) => d.onTime), false);
});

test("reminders: notifications off or task done produce nothing", () => {
  const dueAt = at("2026-10-07", 18);
  assert.deepEqual(sequenceForTask(task({ dueAt, dueTime: "6 PM" }), settings({ notificationFrequency: "NONE" }), TZ, 9, undefined, NOW), []);
  assert.deepEqual(sequenceForTask(task({ dueAt, dueTime: "6 PM", status: "COMPLETED" }), settings(), TZ, 9, undefined, NOW), []);
});

test("reminders: placement shifts out of quiet hours but keeps the on-time alarm", () => {
  const horizon = at("2026-10-12", 0);
  const dueAt = at("2026-10-08", 18);
  const night: Draft = { at: at("2026-10-06", 23, 30), level: "normal", body: "" };
  assert.equal(label({ ...night, at: placeTaskReminder(night, dueAt, settings(), TZ, null, NOW, horizon)! }), "2026-10-07 8:00 normal");

  const lateDue = at("2026-10-06", 23, 30);
  const onTime: Draft = { at: lateDue, level: "critical", body: "Due now", onTime: true };
  assert.equal(placeTaskReminder(onTime, lateDue, settings(), TZ, null, NOW, horizon)?.toISOString(), lateDue.toISOString());
});

test("reminders: Do Not Disturb delays reminders unless critical may override", () => {
  const horizon = at("2026-10-12", 0);
  const dueAt = at("2026-10-08", 18);
  const dnd = at("2026-10-05", 12);
  const normal: Draft = { at: at("2026-10-05", 11), level: "normal", body: "" };
  const critical: Draft = { ...normal, level: "critical" };
  assert.equal(placeTaskReminder(normal, dueAt, settings(), TZ, dnd, NOW, horizon)?.toISOString(), dnd.toISOString());
  assert.equal(placeTaskReminder(critical, dueAt, settings(), TZ, dnd, NOW, horizon)?.toISOString(), normal.at.toISOString());
  assert.equal(placeTaskReminder(critical, dueAt, settings({ criticalOverridesDnd: false }), TZ, dnd, NOW, horizon)?.toISOString(), dnd.toISOString());
});

test("reminders: past, out-of-window and after-deadline reminders are dropped", () => {
  const horizon = at("2026-10-12", 0);
  const dueAt = at("2026-10-08", 18);
  const d = (when: Date, onTime = false): Draft => ({ at: when, level: "normal", body: "", onTime });
  assert.equal(placeTaskReminder(d(at("2026-10-05", 9)), dueAt, settings(), TZ, null, NOW, horizon), null);
  assert.equal(placeTaskReminder(d(at("2026-10-13", 12)), at("2026-10-14", 18), settings(), TZ, null, NOW, horizon), null);
  assert.equal(placeTaskReminder(d(dueAt), dueAt, settings(), TZ, null, NOW, horizon), null);
  assert.ok(placeTaskReminder(d(dueAt, true), dueAt, settings(), TZ, null, NOW, horizon));
});

test("reminders: adaptivity is computed per category and overall", () => {
  const logs = [
    { category: "Work", status: "IGNORED", action: null },
    { category: "Work", status: "IGNORED", action: null },
    { category: "Work", status: "IGNORED", action: null },
    { category: "Work", status: "ACTED", action: "DONE" },
    { category: null, status: "ACTED", action: "DONE" },
  ];
  const a = adaptivityFromLogs(logs);
  assert.deepEqual(a.get("Work"), { ignoreRate: 0.75, samples: 4, earlyCompleter: false });
  assert.deepEqual(a.get("Uncategorized"), { ignoreRate: 0, samples: 1, earlyCompleter: true });
  assert.equal(a.get("*")?.samples, 5);
});

test("reminders: often-ignored categories start earlier; early completers get fewer nudges", () => {
  const dueAt = at("2026-10-11", 18); // 6 days left
  const base = plan(dueAt, "6 PM");
  const ignored = plan(dueAt, "6 PM", { ignoreRate: 0.75, samples: 4, earlyCompleter: false });
  assert.equal(ignored.length, base.length + 1);
  assert.equal(label(ignored[0]), "2026-10-07 9:00 normal");
  assert.match(ignored[0].body, /^Heads up/);

  const early = plan(dueAt, "6 PM", { ignoreRate: 0.1, samples: 5, earlyCompleter: true });
  assert.equal(early.some((d) => d.level === "gentle"), false);
  assert.equal(early.some((d) => d.body.startsWith("Due tomorrow")), false);

  // Too little history: no adaptation.
  assert.deepEqual(plan(dueAt, "6 PM", { ignoreRate: 1, samples: 2, earlyCompleter: false }).map(label), base.map(label));
});
