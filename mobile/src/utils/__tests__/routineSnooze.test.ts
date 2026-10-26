import { describe, expect, it } from "vitest";
import { addSnooze, applySnoozes, pruneSnoozes, snoozeRepeats } from "../routineSnooze";

// Pinned clock: 9:00 is the alarm of occurrence o1.
const T = (hhmm: string) => new Date(`2040-03-05T${hhmm}:00.000Z`).getTime();
const iso = (hhmm: string) => new Date(T(hhmm)).toISOString();
const plan = [
  { id: "r:o1:time", routineOccurrenceId: "o1", fireAt: iso("09:00") },
  { id: "r:o1:follow1", routineOccurrenceId: "o1", fireAt: iso("09:20") },
  { id: "r:o1:follow2", routineOccurrenceId: "o1", fireAt: iso("10:00") },
  { id: "r:o2:time", routineOccurrenceId: "o2", fireAt: iso("09:30") },
  { id: "t:x:1", routineOccurrenceId: null, fireAt: iso("09:05") },
];
const content = { title: "Gym", body: "It's time (9:00 AM)" };

describe("routine snooze", () => {
  it("moves the snoozed occurrence's remaining reminders by 15 minutes; others stay", () => {
    const s = addSnooze({}, "o1", T("09:01"), content);
    expect(applySnoozes(plan, s).map((r) => [r.id, r.fireAt])).toEqual([
      ["r:o1:follow1", iso("09:35")],
      ["r:o1:follow2", iso("10:15")],
      ["r:o2:time", iso("09:30")],
      ["t:x:1", iso("09:05")],
    ]);
    expect(snoozeRepeats(s, ["o1", "o2"], T("09:02"))).toEqual([{ occurrenceId: "o1", fireAt: iso("09:16"), ...content }]);
  });
  it("a second snooze moves them again; the repeat is 15 minutes after the last one", () => {
    const s = addSnooze(addSnooze({}, "o1", T("09:01"), content), "o1", T("09:16"), content);
    expect(applySnoozes(plan, s).filter((r) => r.routineOccurrenceId === "o1").map((r) => r.fireAt)).toEqual([iso("09:50"), iso("10:30")]);
    expect(snoozeRepeats(s, ["o1"], T("09:17"))[0].fireAt).toBe(iso("09:31"));
  });
  it("done or skipped (not pending any more): the snoozed alarm doesn't come back; old snoozes are forgotten", () => {
    const s = addSnooze({}, "o1", T("09:01"), content);
    expect(snoozeRepeats(s, ["o2"], T("09:02"))).toEqual([]);
    expect(pruneSnoozes(s, T("09:01") + 25 * 3600000)).toEqual({});
  });
});
