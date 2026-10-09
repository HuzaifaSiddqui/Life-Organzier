import assert from "node:assert/strict";
import { test } from "node:test";
import { computeEstimateRatios, ratiosByCompletion, suggestDuration, type RatioTask } from "../src/modules/patterns/estimateRatio";

const t0 = new Date("2026-10-01T10:00:00Z");
const task = (actualMin: number, est = 60, o: Partial<RatioTask> = {}): RatioTask => ({
  category: "Academic",
  durationMinutes: est,
  startedAt: t0,
  completedAt: new Date(t0.getTime() + actualMin * 60000),
  scheduledStart: t0,
  hadPartialProgress: false,
  tz: "UTC",
  ...o,
});
const five = (m: number) => Array.from({ length: 5 }, () => task(m));

test("median ratio per category", () => {
  const r = computeEstimateRatios([task(60), task(90), task(84), task(84), task(120)]);
  assert.deepEqual(r, [{ category: "Academic", ratio: 1.4, n: 5 }]);
});

test("outliers (<0.2 or >4) are ignored", () => {
  const r = computeEstimateRatios([...five(60), task(5), task(600)]);
  assert.equal(r[0].n, 5);
  assert.equal(r[0].ratio, 1);
});

test("partial progress and rescheduled-after-start tasks are excluded", () => {
  const later = new Date(t0.getTime() + 3600000);
  const r = computeEstimateRatios([...five(60), task(200, 60, { hadPartialProgress: true }), task(200, 60, { scheduledStart: later })]);
  assert.equal(r[0].n, 5);
  assert.equal(r[0].ratio, 1);
});

test("fewer than 5 samples gives no ratio; missing fields excluded", () => {
  assert.deepEqual(computeEstimateRatios([task(60), task(60), task(60), task(60)]), []);
  assert.deepEqual(computeEstimateRatios([...five(60).slice(0, 4), task(60, 60, { startedAt: null })]), []);
});

test("suggestDuration rounds to 15 min and needs a ≥15 min difference", () => {
  assert.equal(suggestDuration(120, 1.4), 165);
  assert.equal(suggestDuration(60, 1.1), null);
  assert.equal(suggestDuration(60, 1.25), 75);
});

test("tasks completed on a different local day than they started are excluded", () => {
  const night = new Date("2026-10-01T23:00:00Z");
  const overnight = (o: Partial<RatioTask> = {}) => task(120, 120, { startedAt: night, completedAt: new Date(night.getTime() + 120 * 60000), scheduledStart: night, ...o });
  assert.deepEqual(computeEstimateRatios(Array.from({ length: 5 }, () => overnight())), []); // 23:00 → 01:00 UTC
  // the same instants are one local day in Karachi (UTC+5: 04:00 → 06:00)
  assert.equal(computeEstimateRatios(Array.from({ length: 5 }, () => overnight({ tz: "Asia/Karachi" })))[0].ratio, 1);
});

test("ratios are reported separately for check-in and manual completions", () => {
  const r = ratiosByCompletion([...five(60).map((x) => ({ ...x, completedVia: "CHECKIN" })), ...Array.from({ length: 5 }, () => task(120))]);
  assert.deepEqual(r.map((x) => [x.via, x.ratio]), [["CHECKIN", 1], ["MANUAL", 2]]);
  assert.equal(computeEstimateRatios([...five(60), ...five(120)])[0].n, 10); // the user-facing pattern uses both
});
