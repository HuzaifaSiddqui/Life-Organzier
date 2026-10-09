import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import type * as Queue from "../../mobile/src/utils/answerQueue.js";

// The phone's queue policy is pure (no React Native imports), so the backend runner tests it directly.
// mobile/ isn't an ES-module package, hence require instead of a named import.
const { decideAfterFailure, MAX_AGE_MS, MAX_ATTEMPTS } = createRequire(import.meta.url)("../../mobile/src/utils/answerQueue.ts") as typeof Queue;
type AnswerRetryState = Queue.AnswerRetryState;

const tap = new Date("2026-10-09T10:00:00Z");
const fresh = (o: Partial<AnswerRetryState> = {}): AnswerRetryState => ({ respondedAt: tap.toISOString(), ...o });
const at = (ms: number) => new Date(tap.getTime() + ms);

test("answer queue: a 4xx is final and dropped at once", () => {
  assert.deepEqual(decideAfterFailure(fresh(), "client", at(1000)), { action: "drop", reason: "client_error" });
});

test("answer queue: timeouts and 5xx count as attempts and the queue moves on", () => {
  for (const failure of ["timeout", "server"] as const) {
    const d = decideAfterFailure(fresh(), failure, at(1000));
    assert.equal(d.action, "keep");
    if (d.action === "keep") {
      assert.equal(d.answer.attempts, 1);
      assert.equal(d.answer.firstTriedAt, tap.toISOString());
      assert.equal(d.stopQueue, false);
    }
  }
});

test("answer queue: being offline is not an attempt and stops the pass", () => {
  const d = decideAfterFailure(fresh({ attempts: 4 }), "offline", at(3600000));
  assert.equal(d.action, "keep");
  if (d.action === "keep") {
    assert.equal(d.answer.attempts, 4);
    assert.equal(d.stopQueue, true);
  }
});

test("answer queue: a poison answer is dropped after 10 attempts, so it can't block the queue", () => {
  let answer: AnswerRetryState = fresh();
  for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
    const d = decideAfterFailure(answer, "server", at(i * 60000));
    assert.equal(d.action, "keep", `attempt ${i}`);
    if (d.action === "keep") answer = d.answer;
  }
  assert.deepEqual(decideAfterFailure(answer, "server", at(MAX_ATTEMPTS * 60000)), { action: "drop", reason: "max_attempts" });
});

test("answer queue: dropped after 48 h even while offline", () => {
  assert.equal(decideAfterFailure(fresh(), "offline", at(MAX_AGE_MS - 1000)).action, "keep");
  assert.deepEqual(decideAfterFailure(fresh(), "offline", at(MAX_AGE_MS)), { action: "drop", reason: "max_age" });
  assert.deepEqual(decideAfterFailure(fresh({ firstTriedAt: tap.toISOString() }), "timeout", at(MAX_AGE_MS + 1)), { action: "drop", reason: "max_age" });
});

test("answer queue: age counts from the first try, not the tap, when that is recorded", () => {
  const later = new Date(tap.getTime() + 40 * 3600000).toISOString();
  assert.equal(decideAfterFailure(fresh({ firstTriedAt: later }), "server", at(50 * 3600000)).action, "keep");
});
