import { describe, expect, it } from "vitest";
import { inRange } from "../taskRange";

const now = new Date(2026, 10, 12, 15, 0); // Thu 12 Nov, 3 PM local
const at = (d: number, h = 10) => new Date(2026, 10, d, h, 0).getTime();

describe("Tasks date range", () => {
  it("Tomorrow is only tomorrow's local day (midnight to midnight)", () => {
    expect(inRange(at(13, 0), "TOMORROW", now)).toBe(true);
    expect(inRange(at(13, 23), "TOMORROW", now)).toBe(true);
    expect(inRange(at(12, 23), "TOMORROW", now)).toBe(false);
    expect(inRange(at(14, 0), "TOMORROW", now)).toBe(false);
    expect(inRange(Infinity, "TOMORROW", now)).toBe(false);
  });
  it("Today, This week and This month keep including overdue work, as before", () => {
    expect(inRange(at(10), "TODAY", now)).toBe(true);
    expect(inRange(at(13), "TODAY", now)).toBe(false);
    expect(inRange(at(18), "WEEK", now)).toBe(true);
    expect(inRange(at(19), "WEEK", now)).toBe(false);
    expect(inRange(Infinity, "MONTH", now)).toBe(false);
    expect(inRange(Infinity, "ALL", now)).toBe(true);
  });
});
