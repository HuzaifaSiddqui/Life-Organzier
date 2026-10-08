import { TaskStatus, type MoodLog, type Task } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { localParts, localYmd, startOfLocalDay } from "../../lib/time.js";
import { logEvent } from "../events/eventService.js";
import { isTaskOverdue } from "../tasks/taskService.js";

export const MOODS = ["stressed", "anxious", "happy", "tired", "motivated", "sad", "overwhelmed", "focused", "calm"] as const;
export type Mood = (typeof MOODS)[number];

export const NEGATIVE: ReadonlySet<string> = new Set(["stressed", "anxious", "overwhelmed", "sad", "tired"]);
export const STRESS: ReadonlySet<string> = new Set(["stressed", "anxious", "overwhelmed"]);

export const DEFAULT_SCORE: Record<Mood, number> = {
  happy: 8,
  motivated: 8,
  focused: 7,
  calm: 7,
  tired: 4,
  sad: 3,
  stressed: 3,
  anxious: 3,
  overwhelmed: 2,
};

export const MOOD_EMOJI: Record<Mood, string> = {
  happy: "😊",
  motivated: "💪",
  focused: "🎯",
  calm: "😌",
  tired: "😴",
  sad: "😔",
  stressed: "😣",
  anxious: "😟",
  overwhelmed: "😵",
};

const LEXICON: Array<{ mood: Mood; re: RegExp }> = [
  { mood: "overwhelmed", re: /\b(overwhelm(?:ed|ing)?|too much (?:to do|work|on my plate)|swamped|drowning|can'?t keep up|buried in)\b/i },
  { mood: "anxious", re: /\b(anxious|anxiety|nervous|worried|worrying|panic(?:king)?|uneasy|scared)\b/i },
  { mood: "stressed", re: /\b(stress(?:ed|ful)?|under pressure|tense|freaking out|burn(?:ed|t)? out)\b/i },
  { mood: "tired", re: /\b(tired|exhausted|sleepy|drained|fatigued|worn out|no energy)\b/i },
  { mood: "sad", re: /\b(sad|down|depressed|unhappy|lonely|low|heartbroken|miserable|upset)\b/i },
  { mood: "motivated", re: /\b(motivated|productive|energetic|pumped|determined|inspired|ready to go)\b/i },
  { mood: "focused", re: /\b(focused|in the zone|concentrated|locked in)\b/i },
  { mood: "happy", re: /\b(happy|great|awesome|amazing|excited|glad|joyful|cheerful|fantastic|wonderful)\b/i },
  { mood: "calm", re: /\b(calm|relaxed|peaceful|chill|at ease|content)\b/i },
];

export { CRISIS_RESOURCES, crisisForText, crisisPayload, crisisResponse, detectCrisis, type CrisisPayload } from "./crisis.js";

export type MoodDetection = { mood: Mood; confidence: number; explicit: boolean };

/** Rule-based mood detection with negation handling and a confidence score (FR-MH-001 §2). */
export function detectMood(text: string): MoodDetection | null {
  const t = text.toLowerCase();
  for (const { mood, re } of LEXICON) {
    const m = t.match(re);
    if (!m || m.index === undefined) continue;
    const before = t.slice(Math.max(0, m.index - 14), m.index);
    if (/\b(not|n'?t|never|no longer)\s+(?:\w+\s+)?$/.test(before)) continue;
    if (mood === "happy" && /\b(great|awesome|amazing|fantastic|wonderful)\b/.test(m[0]) && !/\b(i(?:'m| am)|feel|feeling)\b/.test(t)) {
      continue;
    }
    if (mood === "sad" && m[0] === "low" && !/\b(feel|feeling|i(?:'m| am))\b/.test(t)) continue;
    if (mood === "sad" && m[0] === "down" && !/\b(feel|feeling|i(?:'m| am))\s+(?:\w+\s+)?down\b/.test(t)) continue;
    const explicit = /\b(i(?:'m| am| feel| was)|feeling|making me|feel so|feel really|so)\b/.test(t);
    const intensifier = /\b(really|so|very|extremely|super|too)\b/.test(t);
    const confidence = Math.min(0.95, (explicit ? 0.85 : 0.65) + (intensifier ? 0.05 : 0));
    return { mood, confidence, explicit };
  }
  return null;
}

export function isMood(value: string): value is Mood {
  return (MOODS as readonly string[]).includes(value);
}

export async function logMood(
  userId: string,
  tz: string,
  input: { mood: Mood; score?: number | null; source: string; confidence?: number | null; note?: string | null },
): Promise<MoodLog> {
  const now = new Date();
  const todayStart = startOfLocalDay(localYmd(now, tz), tz);
  const tomorrowStart = new Date(todayStart.getTime() + 86400000);
  const [active, completedToday] = await Promise.all([
    prisma.task.findMany({
      where: { userId, status: { in: [TaskStatus.PENDING, TaskStatus.IN_PROGRESS] }, archived: false },
      select: { dueAt: true, status: true, archived: true, priority: true },
    }),
    prisma.task.count({ where: { userId, status: TaskStatus.COMPLETED, completedAt: { gte: todayStart } } }),
  ]);
  const log = await prisma.moodLog.create({
    data: {
      userId,
      mood: input.mood,
      score: input.score ?? DEFAULT_SCORE[input.mood],
      source: input.source,
      confidence: input.confidence ?? null,
      note: input.note ?? null,
      context: {
        hour: localParts(now, tz).h,
        pendingCount: active.length,
        overdueCount: active.filter((t) => isTaskOverdue(t, now)).length,
        dueTodayCount: active.filter((t) => t.dueAt && t.dueAt >= todayStart && t.dueAt < tomorrowStart).length,
        urgentCount: active.filter((t) => t.priority === "URGENT" || t.priority === "HIGH").length,
        completedToday,
      },
    },
  });
  logEvent(userId, "MOOD_LOGGED", log.id, { mood: log.mood, score: log.score, source: log.source });
  return log;
}

export async function latestMood(userId: string, withinHours = 12): Promise<MoodLog | null> {
  return prisma.moodLog.findFirst({
    where: { userId, createdAt: { gte: new Date(Date.now() - withinHours * 3600000) } },
    orderBy: { createdAt: "desc" },
  });
}

export async function moodHistory(userId: string, days = 30): Promise<MoodLog[]> {
  return prisma.moodLog.findMany({
    where: { userId, createdAt: { gte: new Date(Date.now() - days * 86400000) } },
    orderBy: { createdAt: "asc" },
  });
}

/* ---------------------------------------------------------------- recommendations */

export type SuggestionAction =
  | { type: "breathing"; minutes: number }
  | { type: "open_task"; taskId: string }
  | { type: "start_task"; taskId: string }
  | { type: "break_down"; taskId: string }
  | { type: "postpone_nonurgent" }
  | { type: "show_top3" }
  | { type: "message"; text: string };

export type Suggestion = { id: string; label: string; detail?: string; action: SuggestionAction };

export type MoodRecommendation = {
  mood: Mood;
  message: string;
  primary: Suggestion | null;
  suggestions: Suggestion[];
  avoid: string[];
};

function say(id: string, label: string, text: string): Suggestion {
  return { id, label, action: { type: "message", text } };
}

function breathe(id: string, label: string, minutes: number): Suggestion {
  return { id, label, action: { type: "breathing", minutes } };
}

function isLight(t: Task): boolean {
  return (t.durationMinutes !== null && t.durationMinutes <= 20) || (t.difficulty !== null && t.difficulty <= 2) || t.priority === "LOW";
}

function isChallenging(t: Task): boolean {
  return (t.difficulty !== null && t.difficulty >= 4) || ((t.priority === "HIGH" || t.priority === "URGENT") && (t.durationMinutes ?? 0) >= 60);
}

function byUrgency(a: Task, b: Task): number {
  const rank = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;
  const ad = a.dueAt?.getTime() ?? Infinity;
  const bd = b.dueAt?.getTime() ?? Infinity;
  return ad - bd || rank[a.priority] - rank[b.priority];
}

/**
 * Mood → task mapping (FR-MH-002 §1). Uses the user's real tasks and learned coping strategies so
 * recommendations are personal, never generic.
 */
export function recommendForMood(mood: Mood, tasks: Task[], copingMemories: string[]): MoodRecommendation {
  const active = tasks.filter((t) => t.status === TaskStatus.PENDING || t.status === TaskStatus.IN_PROGRESS).sort(byUrgency);
  const light = active.filter(isLight).slice(0, 2);
  const challenging = active.filter(isChallenging).slice(0, 3);
  const coping: Suggestion[] = copingMemories.slice(0, 2).map((c, i) => ({
    id: `coping-${i}`,
    label: c.replace(/^User\s+/i, "").replace(/\s+helps the user feel better$/i, " helped before"),
    detail: "Something that helped you before",
    action: { type: "message", text: "That sounds good, let's do that" },
  }));
  const taskSuggestion = (t: Task, verb = "open_task"): Suggestion => ({
    id: `task-${t.id}`,
    label: t.title,
    detail: t.durationMinutes ? `${t.durationMinutes} min` : undefined,
    action: verb === "start_task" ? { type: "start_task", taskId: t.id } : { type: "open_task", taskId: t.id },
  });

  switch (mood) {
    case "stressed":
    case "anxious":
      return {
        mood,
        message: "Let's take this slow. How about a short breathing break first?",
        primary: breathe("breathing", "2-minute breathing exercise", 2),
        suggestions: [
          ...coping,
          ...light.map((t) => taskSuggestion(t)),
          say("walk", "Take a 10-minute walk", "I'll take a short walk"),
          say("friend", "Call a friend", "I'll call a friend"),
        ].slice(0, 4),
        avoid: ["long study blocks", "starting new projects"],
      };
    case "overwhelmed":
      return {
        mood,
        message: "Let's slow down and break this down — one thing at a time. You don't have to do everything today.",
        primary: { id: "top3", label: "Show my top 3 urgent things", action: { type: "show_top3" } },
        suggestions: [
          ...(active[0] ? [{ id: `break-${active[0].id}`, label: `Break down "${active[0].title}"`, action: { type: "break_down", taskId: active[0].id } as SuggestionAction }] : []),
          { id: "postpone", label: "Postpone non-urgent tasks", action: { type: "postpone_nonurgent" } } as Suggestion,
          breathe("breathing", "5-minute meditation", 5),
          ...coping,
        ].slice(0, 4),
        avoid: ["adding more tasks"],
      };
    case "tired":
      return {
        mood,
        message: "Low energy is okay. Let's go for easy wins and save the heavy work for later.",
        primary: light[0] ? taskSuggestion(light[0], "start_task") : say("rest", "Take a 20-minute power nap", "I'll rest for 20 minutes"),
        suggestions: [...light.slice(1).map((t) => taskSuggestion(t)), ...coping, say("water", "Drink water and stretch", "Done, I stretched")].slice(0, 3),
        avoid: ["complex problem-solving"],
      };
    case "sad":
      return {
        mood,
        message: "I'm sorry you're feeling down. How about connecting with someone or doing something you enjoy?",
        primary: say("connect", "Message or call someone you like", "I'll reach out to someone"),
        suggestions: [...coping, say("hobby", "15 minutes on a hobby", "I'll spend some time on a hobby"), say("walk", "Go outside for a walk", "I'll go for a walk")].slice(0, 3),
        avoid: ["solitary, demanding tasks"],
      };
    case "happy":
    case "motivated":
    case "focused":
      return {
        mood,
        message: challenging.length ? "Great energy! Which challenge do you want to tackle?" : "Great energy! This is a good time for your most important work.",
        primary: challenging[0] ? taskSuggestion(challenging[0], "start_task") : active[0] ? taskSuggestion(active[0], "start_task") : null,
        suggestions: [...challenging.slice(1), ...active.filter((t) => !challenging.includes(t)).slice(0, 2)].slice(0, 3).map((t) => taskSuggestion(t)),
        avoid: ["boring or repetitive work"],
      };
    default:
      return {
        mood,
        message: "Nice. Here's what's next on your list.",
        primary: active[0] ? taskSuggestion(active[0], "start_task") : null,
        suggestions: active.slice(1, 3).map((t) => taskSuggestion(t)),
        avoid: [],
      };
  }
}
