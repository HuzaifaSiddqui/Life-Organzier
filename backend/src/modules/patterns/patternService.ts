import { Prisma, RoutineOccurrenceStatus, TaskStatus } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { dayName, formatClock, localParts, localYmd } from "../../lib/time.js";

/**
 * Behavioural memory (FR-PL-001). Patterns are learned from the user's own history and carry a
 * confidence that grows with sample size: c = (1 − e^(−n/k)) · strength.
 * Recommendations are only surfaced at c ≥ 0.5 (FR-PL-002 §5).
 */

export type Pattern = {
  key: string;
  description: string;
  value: Record<string, unknown>;
  confidence: number;
  sampleSize: number;
};

export type PeakWindow = { start: number; end: number };

export const RECOMMEND_THRESHOLD = 0.5;
const NEGATIVE_MOODS = new Set(["stressed", "anxious", "overwhelmed", "sad", "tired"]);

function sampleConfidence(n: number, k: number): number {
  return 1 - Math.exp(-n / k);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function hoursLabel(w: PeakWindow): string {
  return `${formatClock(w.start, 0)}–${formatClock(w.end % 24, 0)}`;
}

export function peakWindowsLabel(windows: PeakWindow[]): string {
  return windows.map(hoursLabel).join(" and ");
}

/** Groups an hour histogram into up to two contiguous peak windows. */
export function findPeakWindows(hist: number[]): { windows: PeakWindow[]; share: number } {
  const total = hist.reduce((s, v) => s + v, 0);
  if (!total) return { windows: [], share: 0 };
  const max = Math.max(...hist);
  const hot = hist.map((v) => v >= Math.max(1, max * 0.45));
  const windows: PeakWindow[] = [];
  for (let h = 0; h < 24; h += 1) {
    if (!hot[h]) continue;
    const start = h;
    while (h + 1 < 24 && hot[h + 1]) h += 1;
    windows.push({ start, end: h + 1 });
  }
  const ranked = windows
    .map((w) => ({ w, count: hist.slice(w.start, w.end).reduce((s, v) => s + v, 0) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 2);
  const chosen = ranked.map((r) => r.w).sort((a, b) => a.start - b.start);
  const share = ranked.reduce((s, r) => s + r.count, 0) / total;
  return { windows: chosen, share };
}

export async function computePatterns(userId: string, tz: string, now = new Date()): Promise<Pattern[]> {
  const since = new Date(now.getTime() - 120 * 86400000);
  const [tasks, occurrences, moods, opens] = await Promise.all([
    prisma.task.findMany({
      where: { userId, createdAt: { gte: since }, parentTaskId: null },
      select: { status: true, category: true, dueAt: true, completedAt: true, createdAt: true, deletedAt: true },
    }),
    prisma.routineOccurrence.findMany({
      where: { userId, occurrenceDate: { gte: new Date(now.getTime() - 30 * 86400000), lte: now } },
      include: { routine: { select: { id: true, title: true, category: true } } },
    }),
    prisma.moodLog.findMany({ where: { userId, createdAt: { gte: since } }, select: { mood: true, score: true, createdAt: true } }),
    prisma.activityEvent.findMany({
      where: { userId, type: { in: ["APP_OPEN", "TASK_COMPLETED"] }, createdAt: { gte: new Date(now.getTime() - 14 * 86400000) } },
      select: { createdAt: true },
    }),
  ]);
  const patterns: Pattern[] = [];
  const completed = tasks.filter((t) => t.status === TaskStatus.COMPLETED && t.completedAt);

  // 1. Peak productivity hours
  if (completed.length >= 5) {
    const hist = new Array<number>(24).fill(0);
    for (const t of completed) hist[localParts(t.completedAt as Date, tz).h] += 1;
    const { windows, share } = findPeakWindows(hist);
    if (windows.length) {
      patterns.push({
        key: "peak_hours",
        description: `You complete ${Math.round(share * 100)}% of your tasks between ${peakWindowsLabel(windows)}`,
        value: { windows, share: round2(share), histogram: hist },
        confidence: round2(sampleConfidence(completed.length, 40) * (0.5 + 0.5 * share)),
        sampleSize: completed.length,
      });
    }
  }

  // 2. Category performance
  const resolved = tasks.filter(
    (t) =>
      t.status === TaskStatus.COMPLETED ||
      t.status === TaskStatus.SKIPPED ||
      (t.dueAt && t.dueAt < now && t.status !== TaskStatus.DELETED),
  );
  const byCat = new Map<string, { done: number; total: number }>();
  for (const t of resolved) {
    const c = t.category ?? "Uncategorized";
    const entry = byCat.get(c) ?? { done: 0, total: 0 };
    entry.total += 1;
    if (t.status === TaskStatus.COMPLETED) entry.done += 1;
    byCat.set(c, entry);
  }
  const cats = [...byCat.entries()]
    .filter(([, v]) => v.total >= 3)
    .map(([category, v]) => ({ category, rate: round2(v.done / v.total), n: v.total, confidence: round2(sampleConfidence(v.total, 15)) }))
    .sort((a, b) => b.rate - a.rate);
  if (cats.length) {
    const best = cats[0];
    const worst = cats[cats.length - 1];
    patterns.push({
      key: "category_performance",
      description:
        cats.length > 1 && best.rate - worst.rate >= 0.25
          ? `You finish ${Math.round(best.rate * 100)}% of ${best.category} tasks but only ${Math.round(worst.rate * 100)}% of ${worst.category} tasks`
          : `Your best category is ${best.category} (${Math.round(best.rate * 100)}% completed)`,
      value: { categories: cats, best: best.category, worst: worst.category },
      confidence: round2(Math.min(best.confidence, worst.confidence)),
      sampleSize: cats.reduce((s, c) => s + c.n, 0),
    });
  }

  // 3. Procrastination & on-time behaviour
  const withDeadline = completed.filter((t) => t.dueAt);
  if (withDeadline.length >= 4) {
    const leads = withDeadline.map((t) => ((t.dueAt as Date).getTime() - (t.completedAt as Date).getTime()) / 3600000).sort((a, b) => a - b);
    const median = leads[Math.floor(leads.length / 2)];
    const lastMinute = leads.filter((h) => h >= 0 && h <= 24).length / leads.length;
    const late = leads.filter((h) => h < 0).length / leads.length;
    const tendency = lastMinute + late >= 0.6 ? "last_minute" : median >= 72 ? "early" : "steady";
    patterns.push({
      key: "procrastination",
      description:
        tendency === "last_minute"
          ? `You usually finish tasks within a day of the deadline (${Math.round((lastMinute + late) * 100)}% of the time)`
          : tendency === "early"
            ? "You usually finish tasks well before their deadline"
            : "You finish most tasks a day or two before the deadline",
      value: { tendency, medianLeadHours: Math.round(median), lastMinuteShare: round2(lastMinute), lateShare: round2(late), onTimeRate: round2(1 - late) },
      confidence: round2(sampleConfidence(withDeadline.length, 20) * (tendency === "steady" ? 0.7 : 1)),
      sampleSize: withDeadline.length,
    });
  }

  // 4. Routine adherence
  const byRoutine = new Map<string, { title: string; done: number; total: number }>();
  for (const o of occurrences) {
    if (o.status === RoutineOccurrenceStatus.PENDING) continue;
    const entry = byRoutine.get(o.routine.id) ?? { title: o.routine.title, done: 0, total: 0 };
    entry.total += 1;
    if (o.status === RoutineOccurrenceStatus.COMPLETED) entry.done += 1;
    byRoutine.set(o.routine.id, entry);
  }
  const routines = [...byRoutine.entries()].map(([id, v]) => ({
    routineId: id,
    title: v.title,
    adherence: round2(v.done / v.total),
    n: v.total,
    reliable: v.total >= 14 && v.done / v.total >= 0.9,
  }));
  if (routines.length) {
    const reliable = routines.filter((r) => r.reliable);
    const weak = routines.filter((r) => r.n >= 5 && r.adherence < 0.5);
    const n = routines.reduce((s, r) => s + r.n, 0);
    patterns.push({
      key: "routine_adherence",
      description: reliable.length
        ? `${reliable.map((r) => r.title).join(", ")} ${reliable.length === 1 ? "is a reliable routine" : "are reliable routines"}`
        : weak.length
          ? `You often skip ${weak.map((r) => r.title).join(", ")}`
          : `Routine adherence is ${Math.round((routines.reduce((s, r) => s + r.adherence * r.n, 0) / n) * 100)}%`,
      value: { routines },
      confidence: round2(sampleConfidence(n, 14)),
      sampleSize: n,
    });
  }

  // 5. Mood cycles by weekday
  if (moods.length >= 4) {
    const byDay = Array.from({ length: 7 }, () => ({ neg: 0, total: 0, score: 0, scored: 0 }));
    for (const m of moods) {
      const d = byDay[localParts(m.createdAt, tz).weekday];
      d.total += 1;
      if (NEGATIVE_MOODS.has(m.mood)) d.neg += 1;
      if (m.score) {
        d.score += m.score;
        d.scored += 1;
      }
    }
    const worst = byDay
      .map((d, weekday) => ({ weekday, share: d.total ? d.neg / d.total : 0, n: d.total }))
      .filter((d) => d.n >= 2)
      .sort((a, b) => b.share - a.share)[0];
    const negativeShare = moods.filter((m) => NEGATIVE_MOODS.has(m.mood)).length / moods.length;
    if (worst && worst.share >= 0.6) {
      patterns.push({
        key: "mood_cycle",
        description: `You often feel stressed or low on ${dayName(worst.weekday)}s`,
        value: { weekday: worst.weekday, share: round2(worst.share), byDay: byDay.map((d) => ({ neg: d.neg, total: d.total })) },
        confidence: round2(sampleConfidence(worst.n, 4) * worst.share),
        sampleSize: worst.n,
      });
    }
    patterns.push({
      key: "mood_overall",
      description: negativeShare >= 0.5 ? "Most of your recent mood check-ins were stressed, tired or low" : "Your mood has mostly been positive lately",
      value: { negativeShare: round2(negativeShare) },
      confidence: round2(sampleConfidence(moods.length, 10)),
      sampleSize: moods.length,
    });
  }

  // 6. Late-night activity → sleep cycle
  const lateNights = new Set<string>();
  for (const e of opens) {
    const p = localParts(e.createdAt, tz);
    if (p.h >= 0 && p.h < 5) lateNights.add(localYmd(e.createdAt, tz));
  }
  const activeDays = new Set(opens.map((e) => localYmd(e.createdAt, tz))).size;
  if (activeDays >= 5) {
    const share = lateNights.size / Math.min(14, activeDays);
    patterns.push({
      key: "late_night_activity",
      description: `You were active after midnight on ${lateNights.size} of the last ${Math.min(14, activeDays)} days`,
      value: { nights: lateNights.size, days: Math.min(14, activeDays), share: round2(share) },
      confidence: round2(Math.min(1, share * 1.4) * sampleConfidence(activeDays, 7)),
      sampleSize: activeDays,
    });
  }

  // 7. Preferred completion time per category (smart time assignment, FR-RM-001 §5)
  const catHours = new Map<string, number[]>();
  for (const t of completed) {
    const key = t.category ?? "Uncategorized";
    const list = catHours.get(key) ?? [];
    list.push(localParts(t.completedAt as Date, tz).h);
    catHours.set(key, list);
  }
  const preferred = [...catHours.entries()]
    .filter(([, hours]) => hours.length >= 4)
    .map(([category, hours]) => ({ category, hour: hours.sort((a, b) => a - b)[Math.floor(hours.length / 2)], n: hours.length }));
  if (preferred.length) {
    patterns.push({
      key: "category_hours",
      description: preferred.map((p) => `${p.category} around ${formatClock(p.hour, 0)}`).join(", "),
      value: { categories: preferred },
      confidence: round2(sampleConfidence(Math.min(...preferred.map((p) => p.n)), 10)),
      sampleSize: preferred.reduce((s, p) => s + p.n, 0),
    });
  }

  return patterns;
}

/** Cached pattern access — recomputed at most every 20 minutes or when forced. */
export async function getPatterns(userId: string, tz: string, opts: { force?: boolean } = {}): Promise<Pattern[]> {
  const cached = await prisma.userPattern.findMany({ where: { userId } });
  const fresh = cached.length && cached.every((p) => p.updatedAt.getTime() > Date.now() - 20 * 60000);
  if (fresh && !opts.force) {
    return cached.map((p) => ({
      key: p.key,
      description: p.description,
      value: p.value as Record<string, unknown>,
      confidence: p.confidence,
      sampleSize: p.sampleSize,
    }));
  }
  const patterns = await computePatterns(userId, tz);
  await prisma.$transaction([
    prisma.userPattern.deleteMany({ where: { userId, key: { notIn: patterns.map((p) => p.key) } } }),
    ...patterns.map((p) =>
      prisma.userPattern.upsert({
        where: { userId_key: { userId, key: p.key } },
        create: { userId, key: p.key, description: p.description, value: p.value as Prisma.InputJsonValue, confidence: p.confidence, sampleSize: p.sampleSize },
        update: { description: p.description, value: p.value as Prisma.InputJsonValue, confidence: p.confidence, sampleSize: p.sampleSize },
      }),
    ),
  ]);
  return patterns;
}

/** Peak windows used by the scheduler & reminders; falls back to sensible defaults with low confidence. */
export function peakWindowsFrom(patterns: Pattern[]): { windows: PeakWindow[]; learned: boolean; confidence: number } {
  const p = patterns.find((x) => x.key === "peak_hours");
  const windows = (p?.value.windows as PeakWindow[] | undefined) ?? [];
  if (p && windows.length && p.confidence >= RECOMMEND_THRESHOLD) return { windows, learned: true, confidence: p.confidence };
  return { windows: [{ start: 9, end: 12 }, { start: 15, end: 17 }], learned: false, confidence: p?.confidence ?? 0 };
}
