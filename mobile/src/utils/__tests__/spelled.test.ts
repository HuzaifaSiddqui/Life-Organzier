import { describe, expect, it } from "vitest";
import { normalizeSpelled, VOICE_MIN_RUN } from "../spelled";

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
  it("voice transcript: only runs of 3+ letters, so titles like \"section A B\" stay", () => {
    for (const [said, want] of [
      ["section A B", "section A B"],
      ["meet the C S department", "meet the C S department"],
      ["Q.A review", "Q.A review"],
      ["is there any task related to k f c", "is there any task related to kfc"],
      ["is there a k f c task", "is there a kfc task"],
      ["any task about K.F.C", "any task about kfc"],
      ["tasks about kay ef see?", "tasks about kfc?"],
    ] as Array<[string, string]>) expect(normalizeSpelled(said, VOICE_MIN_RUN), said).toBe(want);
  });
});
