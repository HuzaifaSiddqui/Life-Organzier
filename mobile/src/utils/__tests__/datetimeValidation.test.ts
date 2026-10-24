import { describe, expect, it } from "vitest";
import { plannedStartIncomplete } from "../datetimeValidation";

describe("plannedStartIncomplete", () => {
  it("ignores a leftover planned start once the duration is cleared (the fields are hidden and not saved)", () => {
    expect(plannedStartIncomplete({ durationMinutes: null, plannedYmd: "2026-10-25", plannedTime: "" })).toBe(false);
    expect(plannedStartIncomplete({ durationMinutes: null, plannedYmd: "", plannedTime: "4:00 PM" })).toBe(false);
  });
  it("with a duration: half filled or unreadable blocks the save; both or neither is fine", () => {
    expect(plannedStartIncomplete({ durationMinutes: 15, plannedYmd: "2026-10-25", plannedTime: "" })).toBe(true);
    expect(plannedStartIncomplete({ durationMinutes: 15, plannedYmd: "", plannedTime: "4:00 PM" })).toBe(true);
    expect(plannedStartIncomplete({ durationMinutes: 15, plannedYmd: "2026-10-25", plannedTime: "soon" })).toBe(true);
    expect(plannedStartIncomplete({ durationMinutes: 15, plannedYmd: "2026-10-25", plannedTime: "4:00 PM" })).toBe(false);
    expect(plannedStartIncomplete({ durationMinutes: 15, plannedYmd: "", plannedTime: "" })).toBe(false);
  });
});
