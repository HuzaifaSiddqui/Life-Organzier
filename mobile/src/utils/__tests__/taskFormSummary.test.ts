import { describe, expect, it } from "vitest";
import { moreSummary, type MoreValues } from "../taskFormSummary";

const empty: MoreValues = { description: "", category: null, tags: [], durationMinutes: null, difficulty: null, locationContext: null, reminderMode: "ADAPTIVE", reminderMinutes: null, status: "PENDING" };

describe("task form: More options summary", () => {
  it("nothing set (defaults): empty, so the hint shows", () => {
    expect(moreSummary(empty)).toEqual([]);
  });
  it("every collapsed field with a value is listed, so nothing set is hidden", () => {
    const v: MoreValues = { description: "bring printouts", category: "Academic", tags: ["uni", "fyp", "lab", "x"], durationMinutes: 90, difficulty: 4, locationContext: "At University", reminderMode: "NONE", reminderMinutes: 1440, status: "IN_PROGRESS" };
    expect(moreSummary(v, { editing: true, places: 2 })).toEqual(["Notes", "Academic", "#uni #fyp #lab +1", "1h 30m", "Hard", "At University", "No reminders", "1 day before", "2 places", "In progress"]);
  });
  it("status shows only when editing and not the default", () => {
    expect(moreSummary({ ...empty, status: "COMPLETED" })).toEqual([]);
    expect(moreSummary({ ...empty, status: "PENDING" }, { editing: true })).toEqual([]);
  });
});
