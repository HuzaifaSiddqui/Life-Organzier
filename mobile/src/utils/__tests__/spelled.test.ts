import { describe, expect, it } from "vitest";
import { normalizeSpelled } from "../spelled";

/** Same cases as backend/tests/spelled.test.ts: the app and the server must agree. */
const SPELLED_CASES: Array<[string, string]> = [
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

describe("normalizeSpelled", () => {
  it("joins spelled letters; ordinary words stay", () => {
    for (const [said, want] of SPELLED_CASES) expect(normalizeSpelled(said), said).toBe(want);
  });
});
