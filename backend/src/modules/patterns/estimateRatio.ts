import { localYmd } from "../../lib/time.js";
import { rescheduledAfterStart } from "../checkins/checkinPlanner.js";

/** FR-RN-004 §6: how long tasks really take compared with the user's estimate, per category. */
export const MIN_RATIO_SAMPLES = 5;
export const MIN_RATIO = 0.2;
export const MAX_RATIO = 4;

export type RatioTask = {
  category: string | null;
  durationMinutes: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  scheduledStart: Date | null;
  /** True when the user reported partial progress (PARTIAL_x check-in answer) on this task. */
  hadPartialProgress: boolean;
  /** How it was completed; null (older rows) counts as MANUAL. */
  completedVia?: string | null;
  /** The user's timezone: work that crosses local midnight is not a measurement of effort. */
  tz: string;
};

export type EstimateRatio = { category: string; ratio: number; n: number };

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** actual ÷ estimated for one task, or null when it must not count (see rules in the FRD). */
export function taskRatio(t: RatioTask): number | null {
  if (!t.startedAt || !t.completedAt || !t.durationMinutes || t.durationMinutes <= 0) return null;
  if (t.hadPartialProgress || rescheduledAfterStart(t)) return null;
  if (localYmd(t.startedAt, t.tz) !== localYmd(t.completedAt, t.tz)) return null; // left running overnight
  const actual = (t.completedAt.getTime() - t.startedAt.getTime()) / 60000;
  const ratio = actual / t.durationMinutes;
  return ratio < MIN_RATIO || ratio > MAX_RATIO ? null : ratio;
}

/** Median ratio per category with at least MIN_RATIO_SAMPLES usable tasks. */
export function computeEstimateRatios(tasks: RatioTask[]): EstimateRatio[] {
  const byCat = new Map<string, number[]>();
  for (const t of tasks) {
    const r = taskRatio(t);
    if (r === null) continue;
    const c = t.category ?? "Uncategorized";
    byCat.set(c, [...(byCat.get(c) ?? []), r]);
  }
  return [...byCat.entries()]
    .filter(([, rs]) => rs.length >= MIN_RATIO_SAMPLES)
    .map(([category, rs]) => ({ category, ratio: Math.round(median(rs) * 100) / 100, n: rs.length }));
}

/** Suggested duration: estimate × ratio rounded to 15 min; null unless it differs from the estimate by ≥ 15 min. */
export function suggestDuration(minutes: number, ratio: number): number | null {
  const adjusted = Math.round((minutes * ratio) / 15) * 15;
  return adjusted >= 15 && Math.abs(adjusted - minutes) >= 15 ? adjusted : null;
}

/** Ratios split by how the task was completed (check-in answer vs manual), for the evaluation report. */
export function ratiosByCompletion(tasks: RatioTask[]): Array<EstimateRatio & { via: "CHECKIN" | "MANUAL" }> {
  return (["CHECKIN", "MANUAL"] as const).flatMap((via) =>
    computeEstimateRatios(tasks.filter((t) => (t.completedVia === "CHECKIN" ? "CHECKIN" : "MANUAL") === via)).map((r) => ({ ...r, via })),
  );
}
