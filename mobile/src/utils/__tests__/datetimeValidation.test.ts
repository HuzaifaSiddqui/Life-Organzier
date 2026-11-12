import { describe, expect, it } from "vitest";
import { looksFixedTime, plannedSlot, plannedStartIncomplete } from "../datetimeValidation";

describe("plannedSlot (manual planned time)", () => {
  it("the picked date + time is the slot, with or without a duration", () => {
    const withDuration = plannedSlot({ plannedYmd: "2026-11-20", plannedTime: "4:00 PM", durationMinutes: 90 });
    expect(withDuration?.start.getHours()).toBe(16);
    expect(((withDuration?.end.getTime() ?? 0) - (withDuration?.start.getTime() ?? 0)) / 60000).toBe(90);
    const noDuration = plannedSlot({ plannedYmd: "2026-11-20", plannedTime: "9:30 AM", durationMinutes: null });
    expect(noDuration?.start.getMinutes()).toBe(30);
    expect(((noDuration?.end.getTime() ?? 0) - (noDuration?.start.getTime() ?? 0)) / 60000).toBe(30);
    const kept = plannedSlot({ plannedYmd: "2026-11-20", plannedTime: "9:30 AM", durationMinutes: null, plannedMinutes: 45 });
    expect(((kept?.end.getTime() ?? 0) - (kept?.start.getTime() ?? 0)) / 60000).toBe(45);
  });
  it("overrides a suggestion: editing the time after 'Find time' saves the edited time", () => {
    const suggested = { plannedYmd: "2026-11-20", plannedTime: "2:00 PM", durationMinutes: 60 };
    const edited = { ...suggested, plannedTime: "7:00 PM" };
    expect(plannedSlot(edited)?.start.getHours()).toBe(19);
  });
  it("cleared or half filled: no slot", () => {
    expect(plannedSlot({ plannedYmd: "", plannedTime: "", durationMinutes: 60 })).toBeNull();
    expect(plannedSlot({ plannedYmd: "2026-11-20", plannedTime: "", durationMinutes: 60 })).toBeNull();
  });
});

describe("looksFixedTime", () => {
  it("class / meeting / appointment / exam words mean a fixed time", () => {
    for (const t of ["Physics class", "Team meeting", "Dentist appointment", "Maths exam", "Quiz 2"]) expect(looksFixedTime(t)).toBe(true);
    for (const t of ["Write the essay", "Classify notes", "Buy groceries"]) expect(looksFixedTime(t)).toBe(false);
  });
});

describe("plannedStartIncomplete", () => {
  it("half filled or unreadable blocks the save; both or neither is fine", () => {
    expect(plannedStartIncomplete({ plannedYmd: "2026-10-25", plannedTime: "" })).toBe(true);
    expect(plannedStartIncomplete({ plannedYmd: "", plannedTime: "4:00 PM" })).toBe(true);
    expect(plannedStartIncomplete({ plannedYmd: "2026-10-25", plannedTime: "soon" })).toBe(true);
    expect(plannedStartIncomplete({ plannedYmd: "2026-10-25", plannedTime: "4:00 PM" })).toBe(false);
    expect(plannedStartIncomplete({ plannedYmd: "", plannedTime: "" })).toBe(false);
  });
});
