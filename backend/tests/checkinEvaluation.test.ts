import assert from "node:assert/strict";
import { test } from "node:test";
import { accuracyDescriptive, acceptance, cell, checkinCsv, pseudonym, researchComparison, responseRatesByKind, startRate, wilson, type CheckinRow, type EvalTask, type SuggestionRow } from "../src/modules/checkins/evaluation";

const fire = new Date("2026-10-20T10:00:00Z");
const at = (min: number) => new Date(fire.getTime() + min * 60000);
const row = (o: Partial<CheckinRow>): CheckinRow => ({ user: "u1", kind: "START", tone: "FUNNY", hasFirstStep: true, copySource: "LIBRARY", researchMode: false, status: "ANSWERED", response: "STARTED", stale: false, fireAt: fire, respondedAt: at(5), ...o });

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

const sug = (o: Partial<SuggestionRow>): SuggestionRow => ({ user: "u1", action: "SHOWN", surface: "CHAT", category: "Academic", original: 60, suggested: 90, at: fire, day: "2026-10-20", ...o });

test("acceptance dedupes displays per user, category, original minutes and day", () => {
  const a = acceptance([sug({}), sug({}), sug({}), sug({ action: "ACCEPTED" }), sug({ day: "2026-10-21" }), sug({ category: "Work", user: "u2" })]);
  const all = a[0];
  assert.deepEqual([all.category, all.shown, all.accepted, all.users], ["ALL", 3, 1, 2]);
  assert.equal(a.find((x) => x.category === "Academic")!.shown, 2);
  assert.equal(a.find((x) => x.category === "Work")!.accepted, 0);
});

test("cells report distinct users and equal-weight per-user average", () => {
  // u1: 1/1, u2: 1/9 → pooled 2/10 = 20%, per-user average (100% + 11%) / 2
  const c = cell([{ user: "u1", ok: true }, { user: "u2", ok: true }, ...Array.from({ length: 8 }, () => ({ user: "u2", ok: false }))]);
  assert.equal(c.users, 2);
  assert.equal(c.rate, 0.2);
  assert.ok(Math.abs(c.perUserRate! - (1 + 1 / 9) / 2) < 1e-9);
});

test("research comparison uses only research-mode rows: shown vs withheld", () => {
  const rows = [
    row({ researchMode: true }),
    row({ researchMode: true, hasFirstStep: false, copySource: "WITHHELD", response: "NOT_TODAY" }),
    row({ researchMode: false }), // not randomised
    row({ researchMode: false, hasFirstStep: false, copySource: "WITHHELD" }),
    row({ researchMode: true, hasFirstStep: false, copySource: "NONE" }), // no step existed
  ];
  const g = researchComparison(rows);
  assert.deepEqual(g.map((x) => [x.group, x.n, x.k]), [["SHOWN", 1, 1], ["WITHHELD (control)", 1, 0]]);
});

const etask = (user: string, created: number, actual: number, category = "Academic"): EvalTask => ({ user, createdAt: at(created), category, durationMinutes: 60, startedAt: fire, completedAt: at(actual), scheduledStart: fire, hadPartialProgress: false, tz: "UTC" });

test("accuracy: only shown categories, before/after, accepted vs shown-not-accepted", () => {
  const events = [sug({ at: at(100) }), sug({ action: "ACCEPTED", at: at(120) })];
  const r = accuracyDescriptive(
    [
      etask("u1", 10, 90), // before the first display
      etask("u1", 110, 78), // after, accepted not yet
      etask("u1", 200, 66), // after, accepted
      etask("u1", 200, 200, "Work"), // category never shown to u1
      etask("u2", 200, 120), // u2 never shown a suggestion
      etask("u1", 300, 600), // outlier (ratio 10)
    ],
    events,
  );
  assert.deepEqual([r.before.n, r.before.mean], [1, 0.5]);
  assert.equal(r.after.n, 2);
  assert.deepEqual([r.shownNotAccepted.n, r.acceptedBefore.n], [1, 1]);
  assert.ok(Math.abs(r.shownNotAccepted.mean! - 0.3) < 1e-9);
  assert.ok(Math.abs(r.acceptedBefore.mean! - 0.1) < 1e-9);
});

test("pseudonyms are salted: same id differs by salt, stable for one salt", () => {
  assert.equal(pseudonym("user-1", "salt-aaaa"), pseudonym("user-1", "salt-aaaa"));
  assert.notEqual(pseudonym("user-1", "salt-aaaa"), pseudonym("user-1", "salt-bbbb"));
});

test("check-in CSV has no free text columns", () => {
  const header = checkinCsv([row({})]).split("\n")[0];
  assert.ok(!/title|message|email/i.test(header));
});
