import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSpelled } from "../src/lib/spelled.js";

/** Same cases as mobile/src/utils/__tests__/spelled.test.ts. */
export const SPELLED_CASES: Array<[string, string]> = [
  ["is there any task related to k f c", "is there any task related to kfc"],
  ["any task about K.F.C", "any task about kfc"],
  ["any task about K. F. C.", "any task about kfc"],
  ["tasks about kay ef see?", "tasks about kfc?"],
  ["is there a k f c task", "is there a kfc task"],
  ["meet the C S department", "meet the cs department"],
  ["see you tomorrow", "see you tomorrow"],
  ["oh why is it late", "oh why is it late"],
  ["I have a meeting", "I have a meeting"],
  ["buy tea", "buy tea"],
];

test("spelled letters become one word; ordinary words stay", () => {
  for (const [said, want] of SPELLED_CASES) assert.equal(normalizeSpelled(said), want, said);
});
