import assert from "node:assert/strict";
import { test } from "node:test";
import { accuracyBeforeAfter, acceptance, checkinCsv, responseRatesByKind, startRate, wilson, type CheckinRow, type EvalTask, type SuggestionRow } from "../src/modules/checkins/evaluation";

const fire = new Date("2026-10-20T10:00:00Z");
const at = (min: number) => new Date(fire.getTime() + min * 60000);
const row = (o: Partial<CheckinRow>): CheckinRow => ({ user: "u1", kind: "START", tone: "FUNNY", hasFirstStep: true, copySource: "LIBRARY", status: "ANSWERED", response: "STARTED", stale: false, fireAt: fire, respondedAt: at(5), ...o });

test("wilson interval", () => {
  assert.equal(wilson(0, 0), null);
  const w = wilson(5, 10)!;
  assert.ok(Math.abs(w.lo - 0.237) < 0.01 && Math.abs(w.hi - 0.763) < 0.01);
});

test("response rates by kind separate answered, ignored and stale", () => {
  const r = responseRatesByKind([row({}), row({ status: "IGNORED", response: null, respondedAt: null }), row({ stale: true }), row({ kind: "COMPLETION" }), row({ status: "SCHEDULED", response: null })]);
  assert.deepEqual(r.find((x) => x.kind === "START"), { kind: "START", answered: 1, ignored: 1, stale: 1, total: 3 });
  assert.equal(r.find((x) => x.kind === "COMPLETION")!.answered, 1);
});

test("start rate uses tap time within 15 min, excludes stale, flags n<20", () => {
  const rows = [row({}), row({ respondedAt: at(16) }), row({ response: "NOT_TODAY" }), row({ status: "IGNORED", response: null, respondedAt: null }), row({ stale: true }), row({ kind: "START_FOLLOWUP" }), row({ tone: "GENTLE" })];
  const byTone = startRate(rows, (r) => r.tone);
  const funny = byTone.find((g) => g.group === "FUNNY")!;
  assert.deepEqual([funny.k, funny.n, funny.tooFew], [1, 4, true]);
  assert.equal(byTone.find((g) => g.group === "GENTLE")!.rate, 1);
  const big = startRate(Array.from({ length: 20 }, () => row({})), (r) => r.copySource);
  assert.equal(big[0].tooFew, false);
});

test("suggestion acceptance overall and per category", () => {
  const s = (action: "SHOWN" | "ACCEPTED", category: string): SuggestionRow => ({ user: "u1", action, surface: "CHAT", category, original: 60, suggested: 90, at: fire });
  const a = acceptance([s("SHOWN", "Academic"), s("SHOWN", "Academic"), s("ACCEPTED", "Academic"), s("SHOWN", "Work")]);
  assert.deepEqual([a[0].category, a[0].shown, a[0].accepted], ["ALL", 3, 1]);
  assert.equal(a.find((x) => x.category === "Work")!.accepted, 0);
});

test("accuracy before vs after the first suggestion, own users only", () => {
  const t = (user: string, created: number, actual: number): EvalTask => ({ user, createdAt: at(created), category: "Academic", durationMinutes: 60, startedAt: fire, completedAt: at(actual), scheduledStart: fire, hadPartialProgress: false });
  const shown: SuggestionRow[] = [{ user: "u1", action: "SHOWN", surface: "CHAT", category: "Academic", original: 60, suggested: 90, at: at(100) }];
  const r = accuracyBeforeAfter([t("u1", 10, 90), t("u1", 200, 66), t("u2", 200, 120), t("u1", 300, 600)], shown);
  assert.equal(r.before.n, 1);
  assert.equal(r.before.mean, 0.5);
  assert.equal(r.after.n, 1); // u2 never saw a suggestion; the 600-min task is an outlier (ratio 10)
  assert.ok(Math.abs(r.after.mean! - 0.1) < 1e-9);
});

test("check-in CSV has no free text columns", () => {
  const header = checkinCsv([row({})]).split("\n")[0];
  assert.ok(!/title|message|email/i.test(header));
});
