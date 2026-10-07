/**
 * Timezone-aware calendar helpers. All user-facing "days" and "clock times" are interpreted
 * in the user's IANA timezone (stored in UserSettings.timezone, refreshed from the device).
 */

export type LocalParts = { y: number; mo: number; da: number; h: number; mi: number; weekday: number };

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function formatter(tz: string): Intl.DateTimeFormat {
  const zone = isValidTimeZone(tz) ? tz : "UTC";
  let f = formatterCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    });
    formatterCache.set(zone, f);
  }
  return f;
}

export function localParts(instant: Date, tz: string): LocalParts {
  const parts = formatter(tz).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    y: Number(get("year")),
    mo: Number(get("month")),
    da: Number(get("day")),
    h: Number(get("hour")) % 24,
    mi: Number(get("minute")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

export function fmtYmd(y: number, mo: number, da: number): string {
  return `${y}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
}

export function splitYmd(ymd: string): { y: number; mo: number; da: number } | null {
  const m = ymd.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  const chk = new Date(Date.UTC(y, mo - 1, da));
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== da) return null;
  return { y, mo, da };
}

export function localYmd(instant: Date, tz: string): string {
  const p = localParts(instant, tz);
  return fmtYmd(p.y, p.mo, p.da);
}

export function addDaysYmd(ymd: string, n: number): string {
  const p = splitYmd(ymd);
  if (!p) return ymd;
  const u = new Date(Date.UTC(p.y, p.mo - 1, p.da) + n * 86400000);
  return fmtYmd(u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate());
}

export function weekdayOfYmd(ymd: string): number {
  const p = splitYmd(ymd);
  if (!p) return 0;
  return new Date(Date.UTC(p.y, p.mo - 1, p.da, 12)).getUTCDay();
}

export function diffDaysYmd(a: string, b: string): number {
  const pa = splitYmd(a);
  const pb = splitYmd(b);
  if (!pa || !pb) return 0;
  return Math.round((Date.UTC(pb.y, pb.mo - 1, pb.da) - Date.UTC(pa.y, pa.mo - 1, pa.da)) / 86400000);
}

/** Minutes to add to UTC to get local wall time at `instant`. */
export function tzOffsetMinutesAt(instant: Date, tz: string): number {
  const p = localParts(instant, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.da, p.h, p.mi);
  const truncated = Math.floor(instant.getTime() / 60000) * 60000;
  return Math.round((asUtc - truncated) / 60000);
}

/** Converts a local wall-clock time in `tz` into an absolute instant. */
export function zonedTimeToUtc(ymd: string, hour: number, minute: number, tz: string): Date {
  const p = splitYmd(ymd);
  if (!p) return new Date(NaN);
  const guess = Date.UTC(p.y, p.mo - 1, p.da, hour, minute);
  let offset = tzOffsetMinutesAt(new Date(guess), tz);
  let result = guess - offset * 60000;
  const second = tzOffsetMinutesAt(new Date(result), tz);
  if (second !== offset) {
    offset = second;
    result = guess - offset * 60000;
  }
  return new Date(result);
}

export function startOfLocalDay(ymd: string, tz: string): Date {
  return zonedTimeToUtc(ymd, 0, 0, tz);
}

export function minutesOfDay(clock: { h: number; m: number }): number {
  return clock.h * 60 + clock.m;
}

/** Parses "5 PM", "5:30pm", "17:00", "noon", "morning" … into 24h hour/minute. */
export function parseClock(raw: string | null | undefined): { h: number; m: number } | null {
  if (!raw) return null;
  const t = raw
    .trim()
    .toLowerCase()
    .replace(/[   ]/g, " ")
    .replace(/\./g, "")
    .replace(/\s+/g, " ");
  if (!t) return null;
  const words: Record<string, { h: number; m: number }> = {
    morning: { h: 9, m: 0 },
    noon: { h: 12, m: 0 },
    midday: { h: 12, m: 0 },
    afternoon: { h: 15, m: 0 },
    evening: { h: 18, m: 0 },
    night: { h: 21, m: 0 },
    tonight: { h: 21, m: 0 },
    midnight: { h: 0, m: 0 },
    eod: { h: 23, m: 59 },
  };
  if (words[t]) return words[t];
  const ampm = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (ampm) {
    let h = Number(ampm[1]);
    const m = Number(ampm[2] ?? "0");
    if (h < 1 || h > 12 || m > 59) return null;
    if (ampm[3] === "pm" && h < 12) h += 12;
    if (ampm[3] === "am" && h === 12) h = 0;
    return { h, m };
  }
  const h24 = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (h24) {
    const h = Number(h24[1]);
    const m = Number(h24[2]);
    if (h > 23 || m > 59) return null;
    return { h, m };
  }
  return null;
}

export function formatClock(h: number, m: number): string {
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function formatClockFromMinutes(total: number): string {
  const t = ((total % 1440) + 1440) % 1440;
  return formatClock(Math.floor(t / 60), t % 60);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function dayName(weekday: number): string {
  return DAY_NAMES[((weekday % 7) + 7) % 7];
}

/** "Fri, Oct 10" */
export function shortDateLabel(ymd: string): string {
  const p = splitYmd(ymd);
  if (!p) return ymd;
  return `${dayName(weekdayOfYmd(ymd)).slice(0, 3)}, ${MONTHS[p.mo - 1]} ${p.da}`;
}

/** Human label relative to today: "today", "tomorrow", "Friday", or "Fri, Oct 10". */
export function relativeDayLabel(ymd: string, todayYmd: string): string {
  const diff = diffDaysYmd(todayYmd, ymd);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  if (diff > 1 && diff < 7) return dayName(weekdayOfYmd(ymd));
  return shortDateLabel(ymd);
}

/** Local label for an absolute instant, e.g. "Friday 3 PM". */
export function instantLabel(instant: Date, tz: string, now = new Date()): string {
  const p = localParts(instant, tz);
  const ymd = fmtYmd(p.y, p.mo, p.da);
  const day = relativeDayLabel(ymd, localYmd(now, tz));
  return `${day.charAt(0).toUpperCase()}${day.slice(1)} ${formatClock(p.h, p.mi)}`;
}

/** True if local minute-of-day `m` falls in [start, end) where the window may wrap midnight. */
export function inWindow(m: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/**
 * Computes the absolute deadline for a task. `dueDate` may be either a local-midnight instant
 * (mobile pickers) or a UTC-noon instant (parser); both map to the same local calendar day.
 * Date-only deadlines are treated as end of day (11:59 PM), per FR-DP-002.
 */
export function computeDueAt(dueDate: Date | null | undefined, dueTime: string | null | undefined, tz: string): Date | null {
  if (!dueDate || Number.isNaN(dueDate.getTime())) return null;
  const ymd = localYmd(dueDate, tz);
  const clock = parseClock(dueTime) ?? { h: 23, m: 59 };
  return zonedTimeToUtc(ymd, clock.h, clock.m, tz);
}

/** Stored calendar date for a local day (local midnight instant, same shape the mobile pickers send). */
export function dueDateFromYmd(ymd: string, tz: string): Date {
  return startOfLocalDay(ymd, tz);
}
