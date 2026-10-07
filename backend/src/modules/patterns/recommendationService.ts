import { Priority, RoutineFrequency, RoutinePriority, TaskStatus, type User, type UserSettings } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { formatClock, parseClock, dayName } from "../../lib/time.js";
import { logEvent } from "../events/eventService.js";
import { rememberFact } from "../memory/memoryService.js";
import { latestMood } from "../mood/moodService.js";
import { createRoutine } from "../routines/routineService.js";
import { getPatterns, peakWindowsLabel, RECOMMEND_THRESHOLD, type PeakWindow } from "./patternService.js";

export type Recommendation = {
  id: string;
  patternKey: string;
  text: string;
  confidence: number;
  confidenceText: string;
  acceptLabel: string;
};

function sure(confidence: number, claim: string): string {
  return `I'm ${Math.round(confidence * 100)}% sure ${claim}`;
}

function dismissed(settings: UserSettings): Set<string> {
  return new Set(Array.isArray(settings.dismissedInsights) ? (settings.dismissedInsights as string[]) : []);
}

/** Pattern-based recommendations (FR-PL-002) — only patterns at ≥ 50% confidence are shown. */
export async function getRecommendations(user: User, settings: UserSettings): Promise<Recommendation[]> {
  const patterns = await getPatterns(user.id, settings.timezone);
  const skip = dismissed(settings);
  const out: Recommendation[] = [];
  const byKey = new Map(patterns.map((p) => [p.key, p]));

  const peak = byKey.get("peak_hours");
  if (peak && peak.confidence >= RECOMMEND_THRESHOLD) {
    const windows = peak.value.windows as PeakWindow[];
    out.push({
      id: "peak_hours_schedule",
      patternKey: peak.key,
      text: `${peak.description}. Schedule challenging tasks in ${peakWindowsLabel(windows)}?`,
      confidence: peak.confidence,
      confidenceText: sure(peak.confidence, `you're most productive ${peakWindowsLabel(windows)}`),
      acceptLabel: "Yes, use my peak hours",
    });
    const existing = await prisma.routine.findFirst({ where: { userId: user.id, title: { contains: "Focus time", mode: "insensitive" } } });
    if (!existing && windows[0]) {
      out.push({
        id: "study_time_routine",
        patternKey: peak.key,
        text: `Block a daily "Focus time" ${peakWindowsLabel([windows[0]])} on weekdays?`,
        confidence: peak.confidence * 0.95,
        confidenceText: sure(peak.confidence * 0.95, "a fixed focus block would help you"),
        acceptLabel: "Add focus routine",
      });
    }
  }

  const cats = byKey.get("category_performance");
  if (cats && cats.confidence >= RECOMMEND_THRESHOLD) {
    const list = cats.value.categories as Array<{ category: string; rate: number; n: number }>;
    const best = list[0];
    const worst = list[list.length - 1];
    if (best && worst && best.category !== worst.category && best.rate - worst.rate >= 0.3) {
      out.push({
        id: `category_gap:${worst.category}`,
        patternKey: cats.key,
        text: `You're great at ${best.category} tasks (${Math.round(best.rate * 100)}%), but ${worst.category} ones slip (${Math.round(worst.rate * 100)}%). How about we prioritize ${worst.category} tasks too?`,
        confidence: cats.confidence,
        confidenceText: sure(cats.confidence, `${worst.category} tasks need more attention`),
        acceptLabel: `Prioritize ${worst.category}`,
      });
    }
    const health = list.find((c) => c.category === "Health");
    if (health && health.rate < 0.5) {
      out.push({
        id: "health_check",
        patternKey: cats.key,
        text: `Only ${Math.round(health.rate * 100)}% of your health tasks get done. Want a gentle daily health check-in?`,
        confidence: cats.confidence * 0.8,
        confidenceText: sure(cats.confidence * 0.8, "you need to keep a check on your health"),
        acceptLabel: "Add health check-in",
      });
    }
  }

  const proc = byKey.get("procrastination");
  if (proc && proc.confidence >= RECOMMEND_THRESHOLD && proc.value.tendency === "last_minute") {
    out.push({
      id: "procrastination_reminders",
      patternKey: proc.key,
      text: `${proc.description}. Want earlier, more frequent reminders so deadlines feel calmer?`,
      confidence: proc.confidence,
      confidenceText: sure(proc.confidence, "you tend to leave things to the last minute"),
      acceptLabel: "Remind me earlier",
    });
  }

  const night = byKey.get("late_night_activity");
  if (night && night.confidence >= RECOMMEND_THRESHOLD) {
    out.push({
      id: "sleep_winddown",
      patternKey: night.key,
      text: `${night.description}. Add a wind-down routine before bed to protect your sleep?`,
      confidence: night.confidence,
      confidenceText: sure(night.confidence, "your sleep cycle is suffering"),
      acceptLabel: "Add wind-down routine",
    });
  }

  const moodCycle = byKey.get("mood_cycle");
  if (moodCycle && moodCycle.confidence >= RECOMMEND_THRESHOLD) {
    const day = dayName(Number(moodCycle.value.weekday));
    out.push({
      id: `mood_day_lighter:${day}`,
      patternKey: moodCycle.key,
      text: `${moodCycle.description}. Keep ${day}s lighter by scheduling demanding work on other days?`,
      confidence: moodCycle.confidence,
      confidenceText: sure(moodCycle.confidence, `${day}s are hard for you`),
      acceptLabel: `Lighter ${day}s`,
    });
  }

  const mood = byKey.get("mood_overall");
  const recentStress = await latestMood(user.id, 72);
  if (mood && mood.confidence >= RECOMMEND_THRESHOLD && Number(mood.value.negativeShare) >= 0.5 && recentStress) {
    const has = await prisma.routine.findFirst({ where: { userId: user.id, wellnessType: "stress_relief" } });
    if (!has) {
      out.push({
        id: "stress_routine",
        patternKey: mood.key,
        text: "You've been stressed a lot lately. Add a 10-minute daily breathing break?",
        confidence: mood.confidence,
        confidenceText: sure(mood.confidence, "a short daily break would help"),
        acceptLabel: "Add breathing break",
      });
    }
  }

  return out.filter((r) => !skip.has(r.id) && r.confidence >= RECOMMEND_THRESHOLD).sort((a, b) => b.confidence - a.confidence);
}

export async function dismissRecommendation(user: User, settings: UserSettings, id: string): Promise<void> {
  const list = [...dismissed(settings), id].slice(-500);
  await prisma.userSettings.update({ where: { userId: user.id }, data: { dismissedInsights: list } });
  logEvent(user.id, "RECOMMENDATION_REJECTED", null, { id });
}

/** Applies an accepted recommendation and returns a confirmation sentence. */
export async function acceptRecommendation(user: User, settings: UserSettings, id: string): Promise<string> {
  const tz = settings.timezone;
  const patterns = await getPatterns(user.id, tz);
  const peak = patterns.find((p) => p.key === "peak_hours");
  const windows = (peak?.value.windows as PeakWindow[] | undefined) ?? [{ start: 9, end: 12 }];
  let message = "Done.";

  if (id === "peak_hours_schedule") {
    await rememberFact(user.id, { kind: "PREFERENCE", content: `User wants challenging tasks scheduled during ${peakWindowsLabel(windows)}`, importance: 0.8, source: "recommendation" });
    message = `Got it — I'll put your hardest work in ${peakWindowsLabel(windows)}.`;
  } else if (id === "study_time_routine") {
    const w = windows[0];
    await createRoutine(user.id, tz, {
      title: "Focus time",
      frequency: RoutineFrequency.CUSTOM,
      daysOfWeek: [1, 2, 3, 4, 5],
      dueTime: formatClock(w.start, 0),
      durationMinutes: Math.min(180, (w.end - w.start) * 60),
      category: "Work",
      priority: RoutinePriority.IMPORTANT,
      timeLocked: false,
      wellnessType: "focus",
    });
    message = `Added "Focus time" on weekdays at ${formatClock(w.start, 0)}.`;
  } else if (id.startsWith("category_gap:")) {
    const category = id.split(":")[1];
    await rememberFact(user.id, { kind: "GOAL", content: `User wants to prioritize ${category} tasks more`, importance: 0.75, source: "recommendation" });
    const result = await prisma.task.updateMany({
      where: { userId: user.id, category, priority: Priority.LOW, status: { in: [TaskStatus.PENDING, TaskStatus.IN_PROGRESS] } },
      data: { priority: Priority.MEDIUM },
    });
    message = `I'll give ${category} tasks more weight${result.count ? ` and raised ${result.count} of them to medium priority` : ""}.`;
  } else if (id === "health_check") {
    await createRoutine(user.id, tz, {
      title: "Health check-in (water, stretch, meds)",
      frequency: RoutineFrequency.DAILY,
      dueTime: "1 PM",
      durationMinutes: 5,
      category: "Health",
      priority: RoutinePriority.IMPORTANT,
      timeLocked: false,
      wellnessType: "health",
    });
    message = "Added a daily 1 PM health check-in.";
  } else if (id === "procrastination_reminders") {
    await prisma.userSettings.update({ where: { userId: user.id }, data: { notificationFrequency: "FREQUENT" } });
    message = "Switched you to frequent, earlier reminders.";
  } else if (id === "sleep_winddown") {
    const quiet = parseClock(settings.quietStart) ?? { h: 22, m: 0 };
    const minutes = (quiet.h * 60 + quiet.m - 30 + 1440) % 1440;
    await createRoutine(user.id, tz, {
      title: "Wind down (no screens)",
      frequency: RoutineFrequency.DAILY,
      dueTime: formatClock(Math.floor(minutes / 60), minutes % 60),
      durationMinutes: 30,
      category: "Health",
      priority: RoutinePriority.IMPORTANT,
      timeLocked: true,
      wellnessType: "sleep",
    });
    message = `Added a wind-down routine at ${formatClock(Math.floor(minutes / 60), minutes % 60)}.`;
  } else if (id.startsWith("mood_day_lighter:")) {
    const day = id.split(":")[1];
    await rememberFact(user.id, { kind: "PREFERENCE", content: `User prefers lighter workloads on ${day}s`, importance: 0.75, source: "recommendation" });
    message = `Noted — I'll keep ${day}s lighter when planning.`;
  } else if (id === "stress_routine") {
    await createRoutine(user.id, tz, {
      title: "Breathing break",
      frequency: RoutineFrequency.DAILY,
      dueTime: "4 PM",
      durationMinutes: 10,
      category: "Health",
      priority: RoutinePriority.NORMAL,
      timeLocked: false,
      wellnessType: "stress_relief",
    });
    message = "Added a 10-minute breathing break every day at 4 PM.";
  }
  await prisma.userSettings.update({
    where: { userId: user.id },
    data: { dismissedInsights: [...dismissed(settings), id].slice(-500) },
  });
  logEvent(user.id, "RECOMMENDATION_ACCEPTED", null, { id });
  return message;
}
