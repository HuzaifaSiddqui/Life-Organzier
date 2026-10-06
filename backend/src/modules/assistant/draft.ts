import { Priority, TaskSource, TaskType, type Task } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { diffDaysYmd, dueDateFromYmd, parseClock, relativeDayLabel } from "../../lib/time.js";
import { contentTokens, editDistance, formatDuration, fuzzySimilarity } from "../../lib/text.js";
import type { CreateTaskInput } from "../tasks/taskService.js";
import { classifyTaskType, cleanTitle, extractEntities, isVagueTitle, needsDurationByNature, suggestTags, type Entities, type ExtractOptions } from "./entities.js";
import type { TaskDraft, TaskSlot } from "./types.js";

export const AUTO_CREATE_CLARITY = 95;
export const VERY_LOW_CLARITY = 20;

export function draftFromEntities(text: string, title: string, e: Entities, todayYmd: string): TaskDraft {
  const taskType = classifyTaskType(text, e);
  let priority = e.priority ?? Priority.MEDIUM;
  if (!e.priority && e.date && !e.date.fuzzy && diffDaysYmd(todayYmd, e.date.ymd) <= 1 && taskType === TaskType.DEADLINE) priority = Priority.HIGH;
  return {
    title: title || null,
    description: null,
    dueYmd: e.date?.ymd ?? null,
    dueTime: e.time,
    dateText: e.date?.text ?? null,
    dateFuzzy: e.date?.fuzzy ?? false,
    durationMinutes: e.durationMinutes,
    priority,
    priorityExplicit: Boolean(e.priority),
    category: e.category,
    taskType: taskType === TaskType.ROUTINE ? TaskType.FLEXIBLE : taskType,
    difficulty: e.difficulty,
    tags: [...new Set([...e.tags, ...suggestTags(text)])].slice(0, 5),
    context: e.context,
  };
}

function needsTime(d: TaskDraft): boolean {
  return (d.taskType === TaskType.DEADLINE || d.taskType === TaskType.FIXED) && !d.allowNoTime;
}

function needsDuration(d: TaskDraft): boolean {
  return !d.allowNoDuration && needsDurationByNature(d.title ?? "", d.taskType);
}

/**
 * Clarity Index (FR-TM-001): weighted completeness of the slots this kind of task requires.
 *   title 25% · date 35% · time 25% (deadline/fixed tasks) · duration 15% (duration tasks)
 */
export function clarityOf(d: TaskDraft): { clarity: number; missing: TaskSlot[] } {
  const missing: TaskSlot[] = [];
  const vague = isVagueTitle(d.title);
  const titleScore = !d.title ? 0 : vague ? 0.4 : 1;
  if (!d.title || vague) missing.push("title");
  const dateScore = d.dueYmd ? (d.dateFuzzy ? 0.5 : 1) : d.allowNoDate ? 1 : 0;
  if ((!d.dueYmd && !d.allowNoDate) || d.dateFuzzy) missing.push("date");
  const timeScore = needsTime(d) ? (d.dueTime ? 1 : 0) : d.dueYmd || d.allowNoDate ? 1 : 0;
  if (needsTime(d) && !d.dueTime) missing.push("time");
  const durationScore = needsDuration(d) ? (d.durationMinutes ? 1 : 0) : d.dueYmd || d.allowNoDate ? 1 : 0.5;
  if (needsDuration(d) && !d.durationMinutes) missing.push("duration");
  const clarity = Math.round(100 * (0.25 * titleScore + 0.35 * dateScore + 0.25 * timeScore + 0.15 * durationScore));
  return { clarity, missing };
}

/** One natural question covering every missing slot (FR-TM-001 §3 mandatory clarifications). */
export function clarificationQuestion(d: TaskDraft, missing: TaskSlot[]): string {
  const parts: string[] = [];
  const subject = d.title && !isVagueTitle(d.title) ? `"${d.title}"` : "it";
  if (missing.includes("title")) {
    const single = d.title && isVagueTitle(d.title) && d.title.trim().split(/\s+/).length === 1;
    parts.push(single ? `What exactly will you ${(d.title as string).toLowerCase()}?` : "What's the task, exactly?");
  }
  if (missing.includes("date")) {
    parts.push(d.dateFuzzy && d.dateText ? `When ${d.dateText.toLowerCase()} exactly?` : `When should ${subject} be done?`);
  }
  if (missing.includes("time")) parts.push(missing.includes("date") ? "And at what time?" : `What time is ${subject} due?`);
  if (missing.includes("duration")) parts.push("How long will it take?");
  return parts.join(" ");
}

export function draftSummary(d: TaskDraft, todayYmd: string): string {
  const bits: string[] = [d.title ?? "Untitled task"];
  if (d.dueYmd) {
    const day = relativeDayLabel(d.dueYmd, todayYmd);
    bits.push(`${d.taskType === TaskType.FIXED ? "on" : "due"} ${day}${d.dueTime ? ` ${d.dueTime}` : ""}`);
  } else if (d.dueTime) {
    bits.push(`at ${d.dueTime}`);
  }
  if (d.durationMinutes) bits.push(`(${formatDuration(d.durationMinutes)})`);
  return bits.join(" ");
}

/** Fills awaited slots from a follow-up message ("3 PM", "physics", "tomorrow for 2 hours"). */
export function fillDraft(draft: TaskDraft, awaiting: TaskSlot[], text: string, opts: ExtractOptions): { draft: TaskDraft; filled: boolean } {
  const e = extractEntities(text, opts);
  const next: TaskDraft = { ...draft };
  let filled = false;
  if (e.date && (awaiting.includes("date") || !next.dueYmd || next.dateFuzzy)) {
    next.dueYmd = e.date.ymd;
    next.dateText = e.date.text;
    next.dateFuzzy = e.date.fuzzy && !(next.dateFuzzy && e.date.fuzzy);
    filled = true;
  }
  if (e.time) {
    next.dueTime = e.time;
    filled = filled || awaiting.includes("time");
  }
  if (e.durationMinutes) {
    next.durationMinutes = e.durationMinutes;
    filled = true;
  }
  if (e.priority) {
    next.priority = e.priority;
    next.priorityExplicit = true;
    filled = true;
  }
  if (/\b(?:no (?:specific |fixed )?time|any ?time|whenever|end of (?:the )?day|eod|all day)\b/i.test(text) && awaiting.includes("time")) {
    next.allowNoTime = true;
    if (/end of (?:the )?day|eod/i.test(text)) next.dueTime = "11:59 PM";
    filled = true;
  }
  if (/\b(?:no deadline|no due date|someday|no date|not sure when|anytime)\b/i.test(text) && awaiting.includes("date")) {
    next.allowNoDate = true;
    next.dateFuzzy = false;
    filled = true;
  }
  if (/\b(?:not sure|don'?t know|no idea)\b/i.test(text) && awaiting.includes("duration")) {
    next.allowNoDuration = true;
    filled = true;
  }
  if (awaiting.includes("title") && !/\?\s*$|^(?:what|when|where|why|how|who|hi|hello|hey|thanks)\b/i.test(text.trim())) {
    const residual = cleanTitle(e.residual).replace(/^(?:it'?s|its|it is|about|for|on)\s+/i, "");
    if (residual && residual.length >= 2 && !/^(?:yes|no|ok|okay|sure)$/i.test(residual)) {
      const vagueVerb = draft.title && isVagueTitle(draft.title) ? draft.title : null;
      next.title = vagueVerb && !residual.toLowerCase().startsWith(vagueVerb.toLowerCase()) ? `${vagueVerb} ${residual}` : residual.charAt(0).toUpperCase() + residual.slice(1);
      filled = true;
    }
  }
  if (e.category && !next.category) next.category = e.category;
  if (e.difficulty) next.difficulty = e.difficulty;
  if (e.tags.length) next.tags = [...new Set([...next.tags, ...e.tags])];
  if (filled) {
    next.taskType = next.taskType === TaskType.FLEXIBLE && next.dueTime && /\b(?:by|due)\b/i.test(text) ? TaskType.DEADLINE : next.taskType;
  }
  return { draft: next, filled };
}

export function draftToCreateInput(d: TaskDraft, tz: string, source: TaskSource, confidence: number): CreateTaskInput {
  return {
    title: d.title ?? "Untitled task",
    description: d.description,
    dueDate: d.dueYmd ? dueDateFromYmd(d.dueYmd, tz) : null,
    dueTime: d.dueTime && parseClock(d.dueTime) ? d.dueTime : null,
    priority: d.priority,
    category: d.category,
    source,
    confidence,
    durationMinutes: d.durationMinutes,
    difficulty: d.difficulty,
    taskType: d.taskType,
    tags: d.tags.length ? d.tags : null,
    locationContext: d.context,
    scheduledStart: d.scheduledStart ? new Date(d.scheduledStart) : null,
    scheduledEnd: d.scheduledEnd ? new Date(d.scheduledEnd) : null,
  };
}

/* ------------------------------------------------------------------ typo correction (FR-EH-003 §4) */

const VOCAB = [
  "assignment", "homework", "exam", "examination", "meeting", "project", "presentation", "report", "appointment",
  "groceries", "medicine", "workout", "exercise", "doctor", "dentist", "submission", "lecture", "quiz", "midterm",
  "interview", "laundry", "shopping", "birthday", "physics", "chemistry", "biology", "mathematics", "calculus",
  "english", "history", "computer", "programming", "research", "thesis", "proposal", "invoice", "payment",
  "meditation", "breakfast", "dinner", "lunch", "study", "revision", "chapter", "practice", "reading", "writing",
];

export async function detectTypo(userId: string, title: string): Promise<string | null> {
  const words = title.split(/\s+/);
  const corrections = await prisma.memoryItem.findMany({ where: { userId, kind: "CORRECTION" }, select: { metadata: true } });
  const learned = new Map<string, string>();
  for (const c of corrections) {
    const m = c.metadata as Record<string, string> | null;
    if (m?.from && m?.to) learned.set(m.from.toLowerCase(), m.to);
  }
  let changed = false;
  const fixed = words.map((w) => {
    const lower = w.toLowerCase().replace(/[^a-z]/g, "");
    if (lower.length < 5 || VOCAB.includes(lower)) return w;
    const known = learned.get(lower);
    if (known) {
      changed = true;
      return known;
    }
    let best: { word: string; d: number } | null = null;
    for (const v of VOCAB) {
      if (Math.abs(v.length - lower.length) > 2) continue;
      const d = editDistance(lower, v);
      if (d > 0 && d <= (lower.length >= 8 ? 2 : 1) && (!best || d < best.d)) best = { word: v, d };
    }
    if (!best) return w;
    changed = true;
    return w.charAt(0) === w.charAt(0).toUpperCase() ? best.word.charAt(0).toUpperCase() + best.word.slice(1) : best.word;
  });
  return changed ? fixed.join(" ") : null;
}

/** Applies corrections the user accepted before, without asking again ("Learning: system remembers corrections"). */
export async function applyLearnedCorrections(userId: string, title: string): Promise<string> {
  const corrections = await prisma.memoryItem.findMany({ where: { userId, kind: "CORRECTION" }, select: { metadata: true } });
  if (!corrections.length) return title;
  const map = new Map<string, string>();
  for (const c of corrections) {
    const m = c.metadata as Record<string, string> | null;
    if (m?.from && m?.to) map.set(m.from.toLowerCase(), m.to);
  }
  return title
    .split(/\s+/)
    .map((w) => map.get(w.toLowerCase().replace(/[^a-z]/g, "")) ?? w)
    .join(" ");
}

/* ------------------------------------------------------------------ task reference resolution */

const PRONOUN = /^(?:it|this|that|this one|that one|the task|the last one|last one|the previous one|same|the same)?$/i;

export type Resolution = { task: Task | null; candidates: Task[]; viaFocus: boolean };

/** Resolves "it" / "the math assignment" / typos to a concrete task using dialogue focus + fuzzy matching. */
export async function resolveTaskRef(
  userId: string,
  ref: string,
  focus: string[],
  opts: { includeCompleted?: boolean } = {},
): Promise<Resolution> {
  const statuses = opts.includeCompleted ? undefined : { in: ["PENDING", "IN_PROGRESS"] as Array<"PENDING" | "IN_PROGRESS"> };
  const tasks = await prisma.task.findMany({
    where: { userId, status: statuses ?? { not: "DELETED" }, archived: false },
    orderBy: { updatedAt: "desc" },
    take: 300,
  });
  const cleaned = ref.trim();
  if (PRONOUN.test(cleaned) || !contentTokens(cleaned).length) {
    for (const id of focus) {
      const t = tasks.find((x) => x.id === id);
      if (t) return { task: t, candidates: [], viaFocus: true };
    }
    return { task: null, candidates: tasks.slice(0, 3), viaFocus: false };
  }
  const scored = tasks
    .map((t) => ({ t, s: fuzzySimilarity(cleaned, t.title) + (focus.includes(t.id) ? 0.08 : 0) }))
    .filter((x) => x.s >= 0.34)
    .sort((a, b) => b.s - a.s);
  if (!scored.length) return { task: null, candidates: [], viaFocus: false };
  const [first, second] = scored;
  if (first.s >= 0.5 && (!second || first.s - second.s >= 0.12)) return { task: first.t, candidates: [], viaFocus: false };
  return { task: null, candidates: scored.slice(0, 4).map((x) => x.t), viaFocus: false };
}
