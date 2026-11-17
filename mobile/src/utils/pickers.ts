import { addDays, dayKey, startOfDay } from "./timeline";

/**
 * Custom date / time pickers (UI v3, components/pickers): the quick choices and the wheel maths. Pure, tested in
 * __tests__/pickers.test.ts.
 */

export type QuickDate = { key: "today" | "tomorrow" | "weekend" | "nextWeek"; ymd: string };

/** Today, Tomorrow, This weekend (Saturday; next one when it's already the weekend), Next week (next Monday). */
export function quickDates(now = new Date()): QuickDate[] {
  const today = startOfDay(now);
  const dow = today.getDay(); // 0 Sun … 6 Sat
  const toSat = dow === 6 ? 7 : dow === 0 ? 6 : 6 - dow;
  const toMon = dow === 1 ? 7 : (8 - dow) % 7 || 7;
  return [
    { key: "today", ymd: dayKey(today) },
    { key: "tomorrow", ymd: dayKey(addDays(today, 1)) },
    { key: "weekend", ymd: dayKey(addDays(today, toSat)) },
    { key: "nextWeek", ymd: dayKey(addDays(today, toMon)) },
  ];
}

/** "2026-11-17" → local Date (midnight), or null. */
export function parseYmd(ymd: string | null | undefined): Date | null {
  const m = (ymd ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export type Clock12 = { hour: number; minute: number; pm: boolean };

export function to12(h: number, m: number): Clock12 {
  return { hour: h % 12 === 0 ? 12 : h % 12, minute: m, pm: h >= 12 };
}

export function from12({ hour, minute, pm }: Clock12): { h: number; m: number } {
  const h = (hour % 12) + (pm ? 12 : 0);
  return { h, m: minute };
}

/** The app's time text: "9:05 AM". */
export function clock12Text(c: Clock12): string {
  return `${c.hour}:${String(c.minute).padStart(2, "0")} ${c.pm ? "PM" : "AM"}`;
}

/** Minutes on the wheel: every `step`, plus the current value when it's off the step (so editing never changes it). */
export function minuteOptions(step = 5, keep?: number): number[] {
  const out: number[] = [];
  for (let m = 0; m < 60; m += step) out.push(m);
  if (keep != null && keep >= 0 && keep < 60 && !out.includes(keep)) out.push(keep);
  return out.sort((a, b) => a - b);
}

/** Quick times: morning 9, noon, afternoon 3, evening 6, night 9, and "in 1 hour" rounded up to 5 minutes. */
export function quickTimes(now = new Date()): Array<{ key: "morning" | "noon" | "afternoon" | "evening" | "night" | "inHour"; h: number; m: number }> {
  const inHour = new Date(now.getTime() + 60 * 60000);
  let m = Math.ceil(inHour.getMinutes() / 5) * 5;
  let h = inHour.getHours();
  if (m === 60) {
    m = 0;
    h = (h + 1) % 24;
  }
  return [
    { key: "inHour", h, m },
    { key: "morning", h: 9, m: 0 },
    { key: "noon", h: 12, m: 0 },
    { key: "afternoon", h: 15, m: 0 },
    { key: "evening", h: 18, m: 0 },
    { key: "night", h: 21, m: 0 },
  ];
}

/** Index of the row nearest to a scroll offset, kept in range. */
export function wheelIndex(offset: number, itemHeight: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.round(offset / itemHeight)));
}
