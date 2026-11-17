import { describe, expect, it } from "vitest";
import { clock12Text, from12, minuteOptions, parseYmd, quickDates, quickTimes, to12, wheelIndex } from "../pickers";

describe("Custom pickers", () => {
  it("quick dates: today, tomorrow, the coming Saturday, next Monday", () => {
    const tue = new Date(2026, 10, 17, 10);
    expect(quickDates(tue).map((q) => q.ymd)).toEqual(["2026-11-17", "2026-11-18", "2026-11-21", "2026-11-23"]);
    const sat = new Date(2026, 10, 21, 10);
    expect(quickDates(sat).map((q) => q.ymd)).toEqual(["2026-11-21", "2026-11-22", "2026-11-28", "2026-11-23"]);
    const sun = new Date(2026, 10, 22, 10);
    expect(quickDates(sun)[2].ymd).toBe("2026-11-28");
    expect(quickDates(sun)[3].ymd).toBe("2026-11-23");
  });

  it("12-hour clock both ways, and the app's time text", () => {
    expect(to12(0, 5)).toEqual({ hour: 12, minute: 5, pm: false });
    expect(to12(12, 0)).toEqual({ hour: 12, minute: 0, pm: true });
    expect(to12(21, 30)).toEqual({ hour: 9, minute: 30, pm: true });
    expect(from12({ hour: 12, minute: 0, pm: false })).toEqual({ h: 0, m: 0 });
    expect(from12({ hour: 12, minute: 15, pm: true })).toEqual({ h: 12, m: 15 });
    expect(from12({ hour: 7, minute: 0, pm: true })).toEqual({ h: 19, m: 0 });
    expect(clock12Text({ hour: 9, minute: 5, pm: false })).toBe("9:05 AM");
  });

  it("minute wheel keeps an off-step value; quick times round 'in 1 hour' up", () => {
    expect(minuteOptions(15)).toEqual([0, 15, 30, 45]);
    expect(minuteOptions(15, 20)).toEqual([0, 15, 20, 30, 45]);
    expect(quickTimes(new Date(2026, 10, 17, 10, 57))[0]).toEqual({ key: "inHour", h: 12, m: 0 });
    expect(quickTimes(new Date(2026, 10, 17, 10, 41))[0]).toEqual({ key: "inHour", h: 11, m: 45 });
  });

  it("parses dates and finds the wheel row", () => {
    expect(parseYmd("2026-11-17")?.getDate()).toBe(17);
    expect(parseYmd("nope")).toBe(null);
    expect(wheelIndex(91, 44, 12)).toBe(2);
    expect(wheelIndex(-30, 44, 12)).toBe(0);
    expect(wheelIndex(9999, 44, 12)).toBe(11);
  });
});
