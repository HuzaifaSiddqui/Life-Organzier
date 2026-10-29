import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapCi, pairedDiffCi } from "../scripts/bootstrap.js";

test("bootstrap CI: brackets the mean, narrows with more items, is reproducible, and refuses mismatched runs", () => {
  const small = [Array.from({ length: 20 }, (_, i) => (i % 2 ? 1 : 0))];
  const big = [Array.from({ length: 400 }, (_, i) => (i % 2 ? 1 : 0))];
  const [lo, hi] = bootstrapCi(small)!;
  assert.ok(lo < 0.5 && hi > 0.5);
  const [blo, bhi] = bootstrapCi(big)!;
  assert.ok(bhi - blo < hi - lo, "more items: a narrower interval");
  assert.deepEqual(bootstrapCi(small), bootstrapCi(small), "fixed seed");
  assert.deepEqual(bootstrapCi([[1, 1, 1, 1]]), [1, 1]);
  assert.equal(bootstrapCi([[1, 0], [1]]), null, "runs that scored different items");
  // Runs are averaged per item first: two runs that disagree on every item give 0.5 per item, so no spread at all.
  assert.deepEqual(bootstrapCi([[1, 0, 1, 0], [0, 1, 0, 1]]), [0.5, 0.5]);
});

test("paired difference: the same items, so a consistent small gain is detected where separate intervals overlap", () => {
  const base = Array.from({ length: 30 }, (_, i) => (i % 2 ? 1 : 0));
  const better = base.map((x, i) => (i < 12 ? 1 : x)); // 6 more correct (items 0, 2 … 10), nothing lost
  const sep = [bootstrapCi([better])!, bootstrapCi([base])!];
  assert.ok(sep[0][0] <= sep[1][1], "separate intervals overlap");
  const p = pairedDiffCi([better], [base])!;
  assert.ok(Math.abs(p.diff - 0.2) < 1e-9);
  assert.ok(p.ci[0] > 0, "the paired interval excludes 0");
  assert.equal(pairedDiffCi([[1, 0]], [[1]]), null);
});
