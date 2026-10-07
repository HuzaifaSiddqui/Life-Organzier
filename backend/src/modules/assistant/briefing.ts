import { RoutineOccurrenceStatus, TaskStatus, TaskType, type User, type UserSettings } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { addDaysYmd, formatClock, localParts, localYmd, parseClock, relativeDayLabel, startOfLocalDay } from "../../lib/time.js";
import { formatDuration, listJoin, plural } from "../../lib/text.js";
import { logEvent } from "../events/eventService.js";
import { latestMood, STRESS, type Mood } from "../mood/moodService.js";
import { getPatterns, peakWindowsFrom, peakWindowsLabel } from "../patterns/patternService.js";
import { getRecommendations, type Recommendation } from "../patterns/recommendationService.js";
import { markMissedOccurrences, occurrenceStart, occurrencesForDay } from "../routines/routineService.js";
import { dayLoad, loadScheduleContext, suggestSlot } from "../scheduling/schedulingService.js";
import { isTaskOverdue, serializeTask, type SerializedTask } from "../tasks/taskService.js";
import type { QuickAction } from "./types.js";

export type AttentionItem = {
  id: string;
  kind:
    | "overdue_deadline"
    | "missed_fixed"
    | "missed_routine_locked"
    | "missed_routine_flexible"
    | "stress_big_task"
    | "very_stressed"
    | "stuck"
    | "overloaded_day";
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  actions: QuickAction[];
  taskId?: string;
  occurrenceId?: string;
};

/**
 * Missed/overdue handling (FR-TM-008, FR-RM-003, FR-MH-003). The system suggests, the user
 * decides — nothing is rescheduled automatically. Only fixed events (classes/meetings) and
 * time-locked routines are marked skipped/missed, exactly as the FRD specifies.
 */
export async function getAttention(user: User, settings: UserSettings, now = new Date()): Promise<AttentionItem[]> {
  const tz = settings.timezone;
  const items: AttentionItem[] = [];
  const todayYmd = localYmd(now, tz);

  // Time-locked routines → missed, next occurrence already exists.
  const missedLocked = await markMissedOccurrences(user.id, tz, now);
  const recentLocked = await prisma.routineOccurrence.findMany({
    where: {
      userId: user.id,
      status: RoutineOccurrenceStatus.MISSED,
      occurrenceDate: { gte: startOfLocalDay(addDaysYmd(todayYmd, -1), tz) },
      updatedAt: { gte: new Date(now.getTime() - 36 * 3600000) },
    },
    include: { routine: true },
    take: 5,
  });
  for (const o of [...missedLocked, ...recentLocked.filter((r) => !missedLocked.some((m) => m.id === r.id))].slice(0, 3)) {
    const next = await prisma.routineOccurrence.findFirst({
      where: { routineId: o.routineId, occurrenceDate: { gt: o.occurrenceDate }, status: RoutineOccurrenceStatus.PENDING },
      orderBy: { occurrenceDate: "asc" },
    });
    const nextLabel = next ? `${relativeDayLabel(localYmd(next.occurrenceDate, tz), todayYmd)}${next.dueTime ? ` ${next.dueTime}` : ""}` : null;
    items.push({
      id: `missed-locked:${o.id}`,
      kind: "missed_routine_locked",
      severity: "info",
      title: `Missed ${o.routine.title}`,
      message: `Missed ${o.routine.title}.${nextLabel ? ` ${nextLabel.charAt(0).toUpperCase()}${nextLabel.slice(1)}'s is ready.` : ""}`,
      actions: [],
      occurrenceId: o.id,
    });
  }

  // Flexible routines from previous days still pending → offer slots this week.
  const flexibleMissed = await prisma.routineOccurrence.findMany({
    where: {
      userId: user.id,
      status: RoutineOccurrenceStatus.PENDING,
      occurrenceDate: { lt: startOfLocalDay(todayYmd, tz), gte: startOfLocalDay(addDaysYmd(todayYmd, -10), tz) },
      routine: { timeLocked: false, active: true },
    },
    include: { routine: true },
    orderBy: { occurrenceDate: "desc" },
    take: 3,
  });
  if (flexibleMissed.length) {
    const ctx = await loadScheduleContext(user.id, settings, 7);
    for (const o of flexibleMissed) {
      const slots: QuickAction[] = [];
      let earliest = now;
      for (let i = 0; i < 2; i += 1) {
        const slot = suggestSlot(ctx, { durationMinutes: o.routine.durationMinutes ?? 30, priority: "MEDIUM", earliest, horizonDays: 6 }, now);
        if (!slot) break;
        const p = localParts(slot.start, tz);
        const time = formatClock(p.h, p.mi);
        slots.push({ label: `${relativeDayLabel(slot.ymd, todayYmd)} ${time}`, payload: { type: "reschedule_occurrence", occurrenceId: o.id, ymd: slot.ymd, time } });
        earliest = new Date(startOfLocalDay(addDaysYmd(slot.ymd, 1), tz).getTime() + 8 * 3600000);
      }
      items.push({
        id: `missed-flex:${o.id}`,
        kind: "missed_routine_flexible",
        severity: "warning",
        title: o.routine.title,
        message: `You missed ${o.routine.title}. Want to reschedule it this week?`,
        actions: [...slots, { label: "Skip for now", payload: { type: "routine_occurrence", occurrenceId: o.id, status: "SKIPPED" } }],
        occurrenceId: o.id,
      });
    }
  }

  const active = await prisma.task.findMany({
    where: { userId: user.id, status: { in: [TaskStatus.PENDING, TaskStatus.IN_PROGRESS] }, archived: false },
    orderBy: { dueAt: { sort: "asc", nulls: "last" } },
  });

  // Fixed events that ended → skipped automatically (no reschedule option).
  for (const t of active) {
    if (t.taskType !== TaskType.FIXED || !t.dueAt) continue;
    const end = new Date(t.dueAt.getTime() + (t.durationMinutes ?? 60) * 60000);
    if (end > now) continue;
    await prisma.task.update({ where: { id: t.id }, data: { status: TaskStatus.SKIPPED, version: t.version + 1, lastModifiedAt: now } });
    logEvent(user.id, "TASK_SKIPPED", t.id, { reason: "missed_fixed", category: t.category });
    items.push({
      id: `missed-fixed:${t.id}`,
      kind: "missed_fixed",
      severity: "info",
      title: t.title,
      message: `You missed ${t.title}.`,
      actions: [{ label: "I attended", payload: { type: "complete_task", taskId: t.id } }],
      taskId: t.id,
    });
  }

  // Overdue deadlines → 4 explicit options (FR-TM-008 §2).
  for (const t of active.filter((x) => x.taskType !== TaskType.FIXED && isTaskOverdue(x, now)).slice(0, 4)) {
    items.push({
      id: `overdue:${t.id}`,
      kind: "overdue_deadline",
      severity: "critical",
      title: t.title,
      message: `"${t.title}" is still pending (was due ${relativeDayLabel(localYmd(t.dueAt as Date, tz), todayYmd)}${t.dueTime ? ` ${t.dueTime}` : ""}).`,
      actions: [
        { label: "Complete now", payload: { type: "overdue_action", taskId: t.id, choice: "complete_now" }, style: "primary" },
        { label: "I couldn't finish", payload: { type: "overdue_action", taskId: t.id, choice: "couldnt" } },
        { label: "Need extension?", payload: { type: "overdue_action", taskId: t.id, choice: "extension" } },
        { label: "Plan finishing", payload: { type: "overdue_action", taskId: t.id, choice: "plan" } },
      ],
      taskId: t.id,
    });
  }

  // Stress-adaptive scheduling (FR-MH-003).
  const mood = await latestMood(user.id, 12);
  const todayEnd = startOfLocalDay(addDaysYmd(todayYmd, 1), tz);
  const dueSoon = active.filter((t) => (t.dueAt && t.dueAt < todayEnd) || (t.scheduledStart && t.scheduledStart < todayEnd));
  if (mood && (mood.score ?? 5) <= 2) {
    const flexible = active.filter((t) => t.priority !== "URGENT" && t.taskType !== TaskType.FIXED).slice(0, 6);
    if (flexible.length) {
      items.push({
        id: `very-stressed:${mood.id}`,
        kind: "very_stressed",
        severity: "warning",
        title: "Take it easy",
        message: `You're going through a lot. Postpone non-urgent tasks? (${plural(flexible.length, "task")} could wait)`,
        actions: [
          { label: "Postpone all", payload: { type: "postpone_nonurgent", taskIds: flexible.map((t) => t.id) }, style: "primary" },
          { label: "Let me choose", payload: { type: "navigate", screen: "TaskList" } },
          { label: "I'm okay", payload: { type: "dismiss_recommendation", id: `very-stressed:${mood.id}` } },
        ],
      });
    }
  } else if (mood && STRESS.has(mood.mood as Mood) && mood.createdAt > new Date(now.getTime() - 6 * 3600000)) {
    const big = dueSoon.find((t) => (t.durationMinutes ?? 0) >= 90 && !t.parentTaskId);
    if (big) {
      items.push({
        id: `stress-big:${big.id}`,
        kind: "stress_big_task",
        severity: "warning",
        title: big.title,
        message: `Big task and you're ${mood.mood}: "${big.title}" (${formatDuration(big.durationMinutes ?? 0)}). Break it down?`,
        actions: [
          { label: "45-min chunks with breaks", payload: { type: "chunk_task", taskId: big.id }, style: "primary" },
          { label: "Move to tomorrow", payload: { type: "postpone_task", taskId: big.id, days: 1 } },
          { label: "Do as scheduled", payload: { type: "dismiss_recommendation", id: `stress-big:${big.id}` } },
        ],
        taskId: big.id,
      });
    }
  }

  // Behavioural stress signal: no completions for 2+ days while work piles up.
  const lastDone = await prisma.task.findFirst({ where: { userId: user.id, status: TaskStatus.COMPLETED }, orderBy: { completedAt: "desc" } });
  if (active.length >= 3 && lastDone?.completedAt && lastDone.completedAt < new Date(now.getTime() - 2 * 86400000)) {
    items.push({
      id: `stuck:${localYmd(now, tz)}`,
      kind: "stuck",
      severity: "info",
      title: "Feeling stuck?",
      message: "Nothing's been ticked off for a couple of days — that's okay. Let's pick one small thing to restart momentum.",
      actions: [{ label: "Show my top 3", payload: { type: "show_top3" }, style: "primary" }],
    });
  }

  const ctx = await loadScheduleContext(user.id, settings, 1);
  const load = dayLoad(ctx, todayYmd);
  if (load.overloaded) {
    items.push({
      id: `overloaded:${todayYmd}`,
      kind: "overloaded_day",
      severity: "warning",
      title: "High workload today",
      message: `Today has ${formatDuration(load.minutes)} planned — more than your ${formatDuration(load.capacity)} capacity. Move some flexible tasks?`,
      actions: [{ label: "Plan my day", payload: { type: "plan_day" }, style: "primary" }],
    });
  }

  const hidden = new Set(Array.isArray(settings.dismissedInsights) ? (settings.dismissedInsights as string[]) : []);
  return items.filter((i) => !hidden.has(i.id));
}

export type Briefing = {
  greeting: string;
  headline: string;
  context: string | null;
  contexts: string[];
  mood: { latest: { mood: string; score: number | null; at: string } | null; checkinDue: boolean };
  today: {
    tasks: SerializedTask[];
    routines: Array<{ id: string; routineId: string; title: string; time: string | null; status: string; priority: string; timeLocked: boolean }>;
    loadMinutes: number;
    capacityMinutes: number;
  };
  nextUp: SerializedTask | null;
  attention: AttentionItem[];
  recommendations: Recommendation[];
  peak: { label: string; learned: boolean; confidence: number };
  stats: { open: number; overdue: number; completedToday: number; dueToday: number };
};

/** Daily mood check-in (FR-MH-001 §3): once a day, ≥1 h after the wake-up routine or first app use. */
async function moodCheckinDue(user: User, tz: string, now: Date): Promise<boolean> {
  const todayStart = startOfLocalDay(localYmd(now, tz), tz);
  const logged = await prisma.moodLog.findFirst({ where: { userId: user.id, createdAt: { gte: todayStart } } });
  if (logged) return false;
  const wake = (await occurrencesForDay(user.id, tz, localYmd(now, tz))).find((o) => /wake|morning|fajr|prayer|meditat/i.test(o.routine.title) && parseClock(o.dueTime));
  if (wake) return now.getTime() >= occurrenceStart(wake, tz).getTime() + 3600000;
  const firstOpen = await prisma.activityEvent.findFirst({
    where: { userId: user.id, type: "APP_OPEN", createdAt: { gte: todayStart } },
    orderBy: { createdAt: "asc" },
  });
  return Boolean(firstOpen && now.getTime() - firstOpen.createdAt.getTime() >= 3600000) || localParts(now, tz).h >= 11;
}

export async function getBriefing(user: User, settings: UserSettings, now = new Date()): Promise<Briefing> {
  const tz = settings.timezone;
  const todayYmd = localYmd(now, tz);
  const todayStart = startOfLocalDay(todayYmd, tz);
  const tomorrowStart = startOfLocalDay(addDaysYmd(todayYmd, 1), tz);
  const attention = await getAttention(user, settings, now);
  const [active, completedToday, routines, mood, recommendations, patterns, checkinDue] = await Promise.all([
    prisma.task.findMany({
      where: { userId: user.id, status: { in: [TaskStatus.PENDING, TaskStatus.IN_PROGRESS] }, archived: false },
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
    }),
    prisma.task.count({ where: { userId: user.id, status: TaskStatus.COMPLETED, completedAt: { gte: todayStart } } }),
    occurrencesForDay(user.id, tz, todayYmd, settings.currentContext),
    latestMood(user.id, 24),
    getRecommendations(user, settings),
    getPatterns(user.id, tz),
    moodCheckinDue(user, tz, now),
  ]);
  const context = settings.currentContext;
  const visible = active.filter((t) => !context || !t.locationContext || t.locationContext === context);
  const today = visible.filter(
    (t) =>
      (t.dueAt && t.dueAt < tomorrowStart) ||
      (t.scheduledStart && t.scheduledStart >= todayStart && t.scheduledStart < tomorrowStart),
  );
  const overdue = visible.filter((t) => isTaskOverdue(t, now));
  const ctx = await loadScheduleContext(user.id, settings, 1);
  const load = dayLoad(ctx, todayYmd);
  const peak = peakWindowsFrom(patterns);
  const hour = localParts(now, tz).h;
  const name = user.displayName?.split(/\s+/)[0] ?? user.email.split("@")[0];
  const greeting = `${hour < 5 ? "Still up" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"}, ${name}`;

  const rank = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;
  const inPeakNow = peak.windows.some((w) => hour >= w.start && hour < w.end);
  const candidates = visible.filter((t) => !t.parentTaskId || !visible.some((p) => p.id === t.parentTaskId));
  const nextUp =
    [...candidates].sort((a, b) => {
      const ad = a.dueAt?.getTime() ?? Infinity;
      const bd = b.dueAt?.getTime() ?? Infinity;
      const aHard = (a.difficulty ?? 3) >= 4 ? (inPeakNow ? -1 : 1) : 0;
      const bHard = (b.difficulty ?? 3) >= 4 ? (inPeakNow ? -1 : 1) : 0;
      return rank[a.priority] - rank[b.priority] || ad - bd || aHard - bHard;
    })[0] ?? null;

  const headlineParts: string[] = [];
  if (today.length) headlineParts.push(`${plural(today.length, "task")} today`);
  if (overdue.length) headlineParts.push(`${overdue.length} overdue`);
  const pendingRoutines = routines.filter((r) => r.status === "PENDING");
  if (pendingRoutines.length) headlineParts.push(plural(pendingRoutines.length, "routine"));
  let headline = headlineParts.length ? `You have ${listJoin(headlineParts)}.` : "Your day is clear — a good time to plan ahead.";
  if (mood && STRESS.has(mood.mood as Mood)) headline += " Let's keep things manageable.";
  else if (inPeakNow && peak.learned) headline += " You're in your most productive hours right now.";

  return {
    greeting,
    headline,
    context,
    contexts: Array.isArray(settings.contexts) ? (settings.contexts as string[]) : [],
    mood: { latest: mood ? { mood: mood.mood, score: mood.score, at: mood.createdAt.toISOString() } : null, checkinDue },
    today: {
      tasks: today.map((t) => serializeTask(t, now)),
      routines: routines.map((o) => ({
        id: o.id,
        routineId: o.routineId,
        title: o.routine.title,
        time: o.dueTime,
        status: o.status,
        priority: o.routine.priority,
        timeLocked: o.routine.timeLocked,
      })),
      loadMinutes: load.minutes,
      capacityMinutes: load.capacity,
    },
    nextUp: nextUp ? serializeTask(nextUp, now) : null,
    attention,
    recommendations: recommendations.slice(0, 3),
    peak: { label: peakWindowsLabel(peak.windows), learned: peak.learned, confidence: peak.confidence },
    stats: { open: visible.length, overdue: overdue.length, completedToday, dueToday: today.length },
  };
}
