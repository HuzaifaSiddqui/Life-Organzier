/**
 * Tasks screen date range (UI v2 adds Tomorrow). `due` is the task's sort time (planned start, else due time, else
 * due date); Infinity = no date. Today, This week and This month include anything earlier (overdue), as before;
 * Tomorrow is only tomorrow's local day.
 */
export type RangeFilter = "ALL" | "TODAY" | "TOMORROW" | "WEEK" | "MONTH";

const DAY = 86400000;

export function inRange(due: number, range: RangeFilter, now = new Date()): boolean {
  if (range === "ALL") return true;
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (range === "TOMORROW") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2).getTime();
    return due >= start && due < end;
  }
  const end = range === "TODAY" ? startToday + DAY : range === "WEEK" ? startToday + 7 * DAY : startToday + 31 * DAY;
  return due < end;
}
