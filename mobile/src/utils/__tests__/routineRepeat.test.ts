import { describe, expect, it } from "vitest";
import { intervalRepeatLabel } from "../routineRepeat";

describe("intervalRepeatLabel", () => {
  it("says every other day / every N days with the start date", () => {
    expect(intervalRepeatLabel(2, "2026-10-25")).toBe("Every other day, starting 25 Oct");
    expect(intervalRepeatLabel(3, "2026-11-01")).toBe("Every 3 days, starting 1 Nov");
    expect(intervalRepeatLabel(7, "bad")).toBe("Every 7 days");
  });
});
