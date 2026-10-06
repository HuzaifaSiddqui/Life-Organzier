import { RoutineOccurrenceStatus, TaskStatus, type Task } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { addDaysYmd, dayName, formatClock, localParts, localYmd, shortDateLabel, startOfLocalDay } from "../../lib/time.js";

export type RangeKey = "week" | "month" | "3months" | "all";

type Bucket = { label: string; from: Date; to: Date };

function rangeBounds(key: RangeKey, tz: string, now: Date, firstActivity: Date | null): { from: Date; to: Date; label: string; bucketDays: number } {
  const today = localYmd(now, tz);
  const to = startOfLocalDay(addDaysYmd(today, 1), tz);
  switch (key) {
    case "week":
      return { from: startOfLocalDay(addDaysYmd(today, -6), tz), to, label: "This week", bucketDays: 1 };
    case "month":
      return { from: startOfLocalDay(addDaysYmd(today, -29), tz), to, label: "This month", bucketDays: 1 };
    case "3months":
      return { from: startOfLocalDay(addDaysYmd(today, -90), tz), to, label: "Last 3 months", bucketDays: 7 };
    case "all":
    default: {
      const start = firstActivity ? localYmd(firstActivity, tz) : addDaysYmd(today, -29);
      const days = Math.max(7, Math.round((to.getTime() - startOfLocalDay(start, tz).getTime()) / 86400000));
      return { from: startOfLocalDay(start, tz), to, label: "All time", bucketDays: days > 120 ? 30 : days > 45 ? 7 : 1 };
    }
  }
}

function inRange(d: Date | null, from: Date, to: Date): boolean {
  return Boolean(d && d >= from && d < to);
}

function periodStats(tasks: Task[], from: Date, to: Date) {
  const created = tasks.filter((t) => inRange(t.createdAt, from, to));
  const completedInPeriod = tasks.filter((t) => t.status === TaskStatus.COMPLETED && inRange(t.completedAt, from, to));
  const dueInPeriod = tasks.filter((t) => inRange(t.dueAt, from, to));
  const relevant = new Set([...created, ...dueInPeriod].map((t) => t.id));
  const relevantDone = [...relevant].filter((id) => tasks.find((t) => t.id === id)?.status === TaskStatus.COMPLETED).length;
  const withDeadline = completedInPeriod.filter((t) => t.dueAt);
  const onTime = withDeadline.filter((t) => (t.completedAt as Date) <= (t.dueAt as Date)).length;
  return {
    created: created.length,
    completed: completedInPeriod.length,
    completionRate: relevant.size ? Math.round((relevantDone / relevant.size) * 100) : 0,
    onTimeRate: withDeadline.length ? Math.round((onTime / withDeadline.length) * 100) : null,
  };
}

export async function getAnalytics(userId: string, tz: string, key: RangeKey = "month", now = new Date()) {
  const tasks = await prisma.task.findMany({ where: { userId, status: { not: TaskStatus.DELETED } } });
  const firstActivity = tasks.reduce<Date | null>((min, t) => (!min || t.createdAt < min ? t.createdAt : min), null);
  const { from, to, label, bucketDays } = rangeBounds(key, tz, now, firstActivity);
  const span = to.getTime() - from.getTime();
  const prevFrom = new Date(from.getTime() - span);
  const current = periodStats(tasks, from, to);
  const previous = key === "all" ? null : periodStats(tasks, prevFrom, from);

  // Trend buckets
  const buckets: Bucket[] = [];
  for (let start = localYmd(from, tz); startOfLocalDay(start, tz) < to; start = addDaysYmd(start, bucketDays)) {
    const bFrom = startOfLocalDay(start, tz);
    const bTo = new Date(Math.min(startOfLocalDay(addDaysYmd(start, bucketDays), tz).getTime(), to.getTime()));
    buckets.push({ label: bucketDays === 1 ? shortDateLabel(start) : `Wk of ${shortDateLabel(start).slice(5)}`, from: bFrom, to: bTo });
    if (buckets.length > 60) break;
  }
  const trend = buckets.map((b) => {
    const s = periodStats(tasks, b.from, b.to);
    return { label: b.label, created: s.created, completed: s.completed, rate: s.completionRate };
  });

  // Categories
  const scoped = tasks.filter((t) => inRange(t.createdAt, from, to) || inRange(t.dueAt, from, to) || inRange(t.completedAt, from, to));
  const catMap = new Map<string, { total: number; completed: number }>();
  for (const t of scoped) {
    const c = t.category ?? "Uncategorized";
    const e = catMap.get(c) ?? { total: 0, completed: 0 };
    e.total += 1;
    if (t.status === TaskStatus.COMPLETED) e.completed += 1;
    catMap.set(c, e);
  }
  const categories = [...catMap.entries()]
    .map(([category, v]) => ({
      category,
      total: v.total,
      completed: v.completed,
      rate: v.total ? Math.round((v.completed / v.total) * 100) : 0,
      share: scoped.length ? Math.round((v.total / scoped.length) * 100) : 0,
    }))
    .sort((a, b) => b.total - a.total);

  // Heatmap of completions (weekday × hour) and timing patterns
  const heatmap = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const completed = tasks.filter((t) => t.status === TaskStatus.COMPLETED && inRange(t.completedAt, from, to));
  for (const t of completed) {
    const p = localParts(t.completedAt as Date, tz);
    heatmap[p.weekday][p.h] += 1;
  }
  const hourTotals = new Array<number>(24).fill(0);
  const dayTotals = new Array<number>(7).fill(0);
  heatmap.forEach((row, d) => row.forEach((v, h) => {
    hourTotals[h] += v;
    dayTotals[d] += v;
  }));
  const bestHour = completed.length ? hourTotals.indexOf(Math.max(...hourTotals)) : null;
  const bestDay = completed.length ? dayTotals.indexOf(Math.max(...dayTotals)) : null;
  const withDue = completed.filter((t) => t.dueAt);
  const avgDaysFromDue = withDue.length
    ? Math.round((withDue.reduce((s, t) => s + ((t.completedAt as Date).getTime() - (t.dueAt as Date).getTime()), 0) / withDue.length / 86400000) * 10) / 10
    : null;

  // Routine adherence
  const occurrences = await prisma.routineOccurrence.findMany({
    where: { userId, occurrenceDate: { gte: from, lt: now }, status: { not: RoutineOccurrenceStatus.PENDING } },
    include: { routine: { select: { id: true, title: true } } },
  });
  const routineMap = new Map<string, { title: string; done: number; total: number }>();
  for (const o of occurrences) {
    const e = routineMap.get(o.routineId) ?? { title: o.routine.title, done: 0, total: 0 };
    e.total += 1;
    if (o.status === RoutineOccurrenceStatus.COMPLETED) e.done += 1;
    routineMap.set(o.routineId, e);
  }
  const routines = [...routineMap.entries()].map(([routineId, v]) => ({
    routineId,
    title: v.title,
    completed: v.done,
    total: v.total,
    adherence: Math.round((v.done / v.total) * 100),
  }));

  const moods = await prisma.moodLog.findMany({ where: { userId, createdAt: { gte: from, lt: to } }, select: { score: true, mood: true } });
  const avgMood = moods.length ? Math.round((moods.reduce((s, m) => s + (m.score ?? 5), 0) / moods.length) * 10) / 10 : null;

  const ranked = categories.filter((c) => c.total >= 2).sort((a, b) => b.rate - a.rate);
  const best = ranked[0] ?? null;
  const worst = ranked.length > 1 ? ranked[ranked.length - 1] : null;

  const insights: Array<{ id: string; text: string; tone: "positive" | "warning" | "info" }> = [];
  if (bestDay !== null && completed.length >= 5) insights.push({ id: `best-day-${bestDay}`, text: `You're most productive on ${dayName(bestDay)}s`, tone: "positive" });
  if (bestHour !== null && completed.length >= 5) insights.push({ id: `best-hour-${bestHour}`, text: `You get the most done around ${formatClock(bestHour, 0)}`, tone: "positive" });
  if (previous && previous.created + previous.completed > 0) {
    const delta = current.completionRate - previous.completionRate;
    if (Math.abs(delta) >= 5) {
      insights.push({
        id: `trend-${key}-${delta > 0 ? "up" : "down"}`,
        text: `Completion rate ${delta > 0 ? "improved" : "dropped"} ${Math.abs(delta)}% vs the previous period`,
        tone: delta > 0 ? "positive" : "warning",
      });
    }
  }
  if (worst && worst.rate < 50) insights.push({ id: `weak-${worst.category}`, text: `${worst.category} tasks completion is down to ${worst.rate}%`, tone: "warning" });
  for (const r of routines.filter((x) => x.total >= 7 && x.adherence >= 90)) insights.push({ id: `routine-${r.routineId}`, text: `${r.title} is a reliable routine (${r.adherence}%)`, tone: "positive" });
  if (avgDaysFromDue !== null && avgDaysFromDue > -0.5) insights.push({ id: "last-minute", text: "You usually finish right at the deadline — earlier reminders might help", tone: "info" });

  return {
    range: { key, label, from: from.toISOString(), to: to.toISOString() },
    totals: {
      ...current,
      open: tasks.filter((t) => t.status === TaskStatus.PENDING || t.status === TaskStatus.IN_PROGRESS).length,
      overdue: tasks.filter((t) => (t.status === TaskStatus.PENDING || t.status === TaskStatus.IN_PROGRESS) && t.dueAt && t.dueAt < now).length,
    },
    previous,
    trend,
    categories,
    routines,
    heatmap,
    bestHour,
    bestDay,
    bestCategory: best?.category ?? null,
    challengingCategory: worst?.category ?? null,
    avgDaysFromDue,
    avgMood,
    insights,
  };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = value instanceof Date ? value.toISOString() : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportCsv(userId: string): Promise<string> {
  const [tasks, routines, moods] = await Promise.all([
    prisma.task.findMany({ where: { userId, status: { not: TaskStatus.DELETED } }, orderBy: { createdAt: "asc" } }),
    prisma.routine.findMany({ where: { userId }, include: { occurrences: true } }),
    prisma.moodLog.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
  ]);
  const lines: string[] = [];
  lines.push("TASKS");
  lines.push(["title", "status", "priority", "category", "type", "due", "completed_at", "progress", "duration_min", "tags", "created_at"].join(","));
  for (const t of tasks) {
    lines.push(
      [t.title, t.status, t.priority, t.category, t.taskType, t.dueAt, t.completedAt, t.progress, t.durationMinutes, Array.isArray(t.tags) ? (t.tags as string[]).join(" ") : "", t.createdAt]
        .map(csvCell)
        .join(","),
    );
  }
  lines.push("", "ROUTINES");
  lines.push(["title", "frequency", "time", "priority", "completed", "skipped", "missed"].join(","));
  for (const r of routines) {
    const count = (s: RoutineOccurrenceStatus) => r.occurrences.filter((o) => o.status === s).length;
    lines.push([r.title, r.frequency, r.dueTime, r.priority, count("COMPLETED"), count("SKIPPED"), count("MISSED")].map(csvCell).join(","));
  }
  lines.push("", "MOOD LOGS");
  lines.push(["mood", "score", "source", "note", "logged_at"].join(","));
  for (const m of moods) lines.push([m.mood, m.score, m.source, m.note, m.createdAt].map(csvCell).join(","));
  return lines.join("\n");
}
