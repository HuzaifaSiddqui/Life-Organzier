import { TaskStatus, TaskType, type Priority, type Task, type UserSettings } from "@prisma/client";
import { prisma } from "../../config/db.js";
import {
  addDaysYmd,
  formatClockFromMinutes,
  inWindow,
  localParts,
  localYmd,
  minutesOfDay,
  parseClock,
  relativeDayLabel,
  zonedTimeToUtc,
} from "../../lib/time.js";
import { formatDuration } from "../../lib/text.js";
import { getPatterns, peakWindowsFrom, type PeakWindow } from "../patterns/patternService.js";
import { occurrenceEnd, occurrenceStart, occurrencesBetween, type OccurrenceWithRoutine } from "../routines/routineService.js";

/**
 * Deterministic scheduler (FR-TM-006). A small local LLM cannot do reliable calendar arithmetic,
 * so slot finding is algorithmic and the assistant only explains the result.
 *
 * Factors: availability (busy blocks from timed tasks + routines), active-hours window and quiet
 * hours, learned peak hours (hard/important work goes there), priority (urgent → earliest),
 * deadline (must finish before it), daily capacity (overload prevention), and smart spacing
 * (no back-to-back hard tasks without a break).
 */

export type Block = {
  start: Date;
  end: Date;
  kind: "task" | "routine" | "break" | "suggested" | "due";
  title: string;
  id: string;
  hard?: boolean;
  mandatory?: boolean;
  status?: string;
};

export type DayLoad = { ymd: string; minutes: number; capacity: number; overloaded: boolean };

export type SlotRequest = {
  durationMinutes: number;
  priority: Priority;
  difficulty?: number | null;
  deadline?: Date | null;
  earliest?: Date | null;
  preferredYmd?: string | null;
  excludeTaskId?: string;
  horizonDays?: number;
};

export type SlotSuggestion = {
  start: Date;
  end: Date;
  ymd: string;
  inPeak: boolean;
  learnedPeak: boolean;
  reason: string;
  dayLoadAfter: number;
};

const STEP = 15;
const DEFAULT_ROUTINE_MIN = 30;
const ACTIVE: TaskStatus[] = [TaskStatus.PENDING, TaskStatus.IN_PROGRESS];

export function taskBlock(task: Task): Block | null {
  if (task.scheduledStart && task.scheduledEnd) {
    return { start: task.scheduledStart, end: task.scheduledEnd, kind: "task", title: task.title, id: task.id, hard: (task.difficulty ?? 0) >= 4, status: task.status };
  }
  if (task.taskType === TaskType.FIXED && task.dueAt && task.dueTime) {
    const end = new Date(task.dueAt.getTime() + (task.durationMinutes ?? 60) * 60000);
    return { start: task.dueAt, end, kind: "task", title: task.title, id: task.id, status: task.status };
  }
  return null;
}

function routineBlock(o: OccurrenceWithRoutine, tz: string): Block | null {
  if (!parseClock(o.dueTime)) return null;
  const start = occurrenceStart(o, tz);
  return {
    start,
    end: new Date(start.getTime() + (o.routine.durationMinutes ?? DEFAULT_ROUTINE_MIN) * 60000),
    kind: "routine",
    title: o.routine.title,
    id: o.id,
    mandatory: o.routine.priority === "MANDATORY",
    status: o.status,
  };
}

/** Minutes committed on a local day: timed blocks + untimed tasks due that day with a duration. */
function loadForDay(ymd: string, tz: string, tasks: Task[], occurrences: OccurrenceWithRoutine[], excludeTaskId?: string): number {
  let minutes = 0;
  for (const t of tasks) {
    if (t.id === excludeTaskId || !ACTIVE.includes(t.status)) continue;
    const block = taskBlock(t);
    if (block) {
      if (localYmd(block.start, tz) === ymd) minutes += (block.end.getTime() - block.start.getTime()) / 60000;
    } else if (t.dueAt && localYmd(t.dueAt, tz) === ymd && !t.parentTaskId) {
      // Deadline-only tasks still take time; assume 30 minutes when no duration is known.
      minutes += (t.durationMinutes ?? 30) * (1 - t.progress / 100);
    }
  }
  for (const o of occurrences) {
    if (o.status === "SKIPPED" || localYmd(o.occurrenceDate, tz) !== ymd) continue;
    minutes += o.routine.durationMinutes ?? (parseClock(o.dueTime) ? DEFAULT_ROUTINE_MIN : 0);
  }
  return Math.round(minutes);
}

export type ScheduleContext = {
  tz: string;
  settings: UserSettings;
  tasks: Task[];
  occurrences: OccurrenceWithRoutine[];
  peak: { windows: PeakWindow[]; learned: boolean; confidence: number };
};

export async function loadScheduleContext(userId: string, settings: UserSettings, horizonDays = 14): Promise<ScheduleContext> {
  const tz = settings.timezone;
  const now = new Date();
  const [tasks, occurrences, patterns] = await Promise.all([
    prisma.task.findMany({ where: { userId, status: { in: ACTIVE }, archived: false } }),
    occurrencesBetween(userId, new Date(now.getTime() - 86400000), new Date(now.getTime() + (horizonDays + 1) * 86400000), settings.currentContext),
    getPatterns(userId, tz),
  ]);
  return { tz, settings, tasks, occurrences, peak: peakWindowsFrom(patterns) };
}

export function busyBlocks(ctx: ScheduleContext, excludeTaskId?: string): Block[] {
  const blocks: Block[] = [];
  for (const t of ctx.tasks) {
    if (t.id === excludeTaskId) continue;
    const b = taskBlock(t);
    if (b) blocks.push(b);
  }
  for (const o of ctx.occurrences) {
    if (o.status === "SKIPPED") continue;
    const b = routineBlock(o, ctx.tz);
    if (b) blocks.push(b);
  }
  return blocks.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export function dayLoad(ctx: ScheduleContext, ymd: string, excludeTaskId?: string): DayLoad {
  const minutes = loadForDay(ymd, ctx.tz, ctx.tasks, ctx.occurrences, excludeTaskId);
  return { ymd, minutes, capacity: ctx.settings.dailyCapacityMinutes, overloaded: minutes > ctx.settings.dailyCapacityMinutes };
}

function inPeak(startMin: number, endMin: number, windows: PeakWindow[]): boolean {
  return windows.some((w) => startMin >= w.start * 60 && endMin <= w.end * 60);
}

/** Finds the best free slot. Returns null when nothing fits before the deadline. */
export function suggestSlot(ctx: ScheduleContext, req: SlotRequest, now = new Date()): SlotSuggestion | null {
  const tz = ctx.tz;
  const duration = Math.max(STEP, Math.min(req.durationMinutes, 12 * 60));
  const blocks = busyBlocks(ctx, req.excludeTaskId);
  const quietStart = minutesOfDay(parseClock(ctx.settings.quietStart) ?? { h: 22, m: 0 });
  const quietEnd = minutesOfDay(parseClock(ctx.settings.quietEnd) ?? { h: 8, m: 0 });
  const workStart = minutesOfDay(parseClock(ctx.settings.workStart) ?? { h: 8, m: 0 });
  const workEnd = minutesOfDay(parseClock(ctx.settings.workEnd) ?? { h: 22, m: 0 });
  const hard = (req.difficulty ?? 3) >= 3 || req.priority === "HIGH" || req.priority === "URGENT";
  const urgent = req.priority === "URGENT";
  const earliest = new Date(Math.max(now.getTime() + 10 * 60000, req.earliest?.getTime() ?? 0));
  const todayYmd = localYmd(now, tz);
  const startYmd = req.preferredYmd && req.preferredYmd >= todayYmd ? req.preferredYmd : localYmd(earliest, tz);
  const horizon = req.horizonDays ?? 14;

  let best: (SlotSuggestion & { score: number }) | null = null;
  for (let d = 0; d <= horizon; d += 1) {
    const ymd = addDaysYmd(startYmd, d);
    const dayStart = zonedTimeToUtc(ymd, 0, 0, tz);
    if (req.deadline && dayStart >= req.deadline) break;
    const load = loadForDay(ymd, tz, ctx.tasks, ctx.occurrences, req.excludeTaskId);
    if (load + duration > ctx.settings.dailyCapacityMinutes && !urgent) continue;
    const dayBlocks = blocks.filter((b) => localYmd(b.start, tz) === ymd || localYmd(b.end, tz) === ymd);

    for (let m = workStart; m + duration <= (workEnd > workStart ? workEnd : 1440); m += STEP) {
      if (inWindow(m, quietStart, quietEnd) || inWindow(m + duration - 1, quietStart, quietEnd)) continue;
      const start = zonedTimeToUtc(ymd, Math.floor(m / 60), m % 60, tz);
      const end = new Date(start.getTime() + duration * 60000);
      if (start < earliest) continue;
      if (req.deadline && end > req.deadline) break;
      const overlaps = dayBlocks.some((b) => b.start < end && b.end > start);
      if (overlaps) continue;
      // Smart spacing: keep a 15-minute gap after a hard block.
      const tooClose = hard && dayBlocks.some((b) => b.hard && b.end <= start && start.getTime() - b.end.getTime() < 15 * 60000);
      const peak = inPeak(m, m + duration, ctx.peak.windows);
      let score = 100 - d * (urgent ? 25 : 8) - (m - workStart) / 60;
      if (hard && peak) score += ctx.peak.learned ? 30 : 15;
      if (!hard && peak) score -= 5;
      if (tooClose) score -= 20;
      if (req.preferredYmd && ymd === req.preferredYmd) score += 15;
      if (!best || score > best.score) {
        best = { start, end, ymd, inPeak: peak, learnedPeak: ctx.peak.learned, reason: "", dayLoadAfter: load + duration, score };
      }
      if (urgent || (d === 0 && score > 120)) break;
    }
    if (best && (urgent || (best.inPeak && d >= 0 && best.ymd === ymd) || d >= 2)) break;
  }
  if (!best) return null;
  const startLocal = localParts(best.start, tz);
  const endLocal = localParts(best.end, tz);
  const label = `${relativeDayLabel(best.ymd, todayYmd)} ${formatClockFromMinutes(startLocal.h * 60 + startLocal.mi)}–${formatClockFromMinutes(endLocal.h * 60 + endLocal.mi)}`;
  best.reason = best.inPeak
    ? best.learnedPeak
      ? `${label} (your most productive time)`
      : `${label} (a usually productive time)`
    : `${label} (your next free slot)`;
  const { score: _score, ...suggestion } = best;
  return suggestion;
}

/** Flexible tasks on a day that could be moved to relieve an overloaded day (FR-TM-006 §4). */
export function movableTasksOn(ctx: ScheduleContext, ymd: string): Task[] {
  return ctx.tasks.filter((t) => {
    if (t.taskType === TaskType.FIXED || t.taskType === TaskType.DEADLINE) return false;
    if (t.priority === "URGENT") return false;
    const block = taskBlock(t);
    const at = block?.start ?? t.dueAt;
    return at ? localYmd(at, ctx.tz) === ymd : false;
  });
}

/**
 * Splits work into focus chunks with breaks (FR-MH-003 §3: 45 min work / 15 min break).
 */
export function chunkPlan(start: Date, totalMinutes: number, chunk = 45, rest = 15): Array<{ start: Date; end: Date; kind: "work" | "break" }> {
  const out: Array<{ start: Date; end: Date; kind: "work" | "break" }> = [];
  let cursor = start.getTime();
  let remaining = totalMinutes;
  while (remaining > 0) {
    const len = Math.min(chunk, remaining);
    out.push({ start: new Date(cursor), end: new Date(cursor + len * 60000), kind: "work" });
    cursor += len * 60000;
    remaining -= len;
    if (remaining > 0) {
      out.push({ start: new Date(cursor), end: new Date(cursor + rest * 60000), kind: "break" });
      cursor += rest * 60000;
    }
  }
  return out;
}

export type DayPlan = {
  ymd: string;
  label: string;
  load: DayLoad;
  blocks: Block[];
  unscheduled: Array<{ id: string; title: string; dueAt: Date | null; durationMinutes: number | null; priority: Priority }>;
  notes: string[];
};

/** Timeline for a day: routines + timed tasks + suggested placements for due-soon flexible work. */
export async function dayPlan(userId: string, settings: UserSettings, ymd: string, now = new Date()): Promise<DayPlan> {
  const ctx = await loadScheduleContext(userId, settings, 3);
  const tz = ctx.tz;
  const blocks = busyBlocks(ctx).filter((b) => localYmd(b.start, tz) === ymd);
  for (const t of ctx.tasks) {
    if (taskBlock(t) || !t.dueAt || !t.dueTime || localYmd(t.dueAt, tz) !== ymd) continue;
    blocks.push({ start: t.dueAt, end: new Date(t.dueAt.getTime() + 15 * 60000), kind: "due", title: t.title, id: t.id, status: t.status });
  }
  const load = dayLoad(ctx, ymd);
  const notes: string[] = [];
  const dayEnd = zonedTimeToUtc(addDaysYmd(ymd, 1), 0, 0, tz);
  const unscheduledTasks = ctx.tasks
    .filter((t) => !taskBlock(t) && t.parentTaskId === null && (!t.dueAt || t.dueAt <= new Date(dayEnd.getTime() + 2 * 86400000)))
    .sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity))
    .slice(0, 8);

  const suggestions: Block[] = [];
  const planningCtx: ScheduleContext = { ...ctx, tasks: [...ctx.tasks] };
  for (const t of unscheduledTasks) {
    if (!t.durationMinutes) continue;
    const slot = suggestSlot(planningCtx, {
      durationMinutes: Math.round(t.durationMinutes * (1 - t.progress / 100)) || t.durationMinutes,
      priority: t.priority,
      difficulty: t.difficulty,
      deadline: t.dueAt,
      preferredYmd: ymd,
      excludeTaskId: t.id,
      horizonDays: 0,
    }, now);
    if (!slot || slot.ymd !== ymd) continue;
    const block: Block = { start: slot.start, end: slot.end, kind: "suggested", title: t.title, id: t.id, hard: (t.difficulty ?? 0) >= 4 };
    suggestions.push(block);
    planningCtx.tasks.push({ ...t, id: `planned-${t.id}`, scheduledStart: slot.start, scheduledEnd: slot.end, difficulty: t.difficulty });
  }
  if (load.overloaded) {
    notes.push(`High workload: ${formatDuration(load.minutes)} planned against your ${formatDuration(load.capacity)} capacity.`);
    const morning = ctx.occurrences.find((o) => localYmd(o.occurrenceDate, tz) === ymd && (parseClock(o.dueTime)?.h ?? 12) < 9);
    if (morning) notes.push(`Very busy day, but your ${morning.routine.title} is kept.`);
  }
  if (!ctx.peak.learned) notes.push("I'm still learning your most productive hours — complete a few more tasks and planning will adapt.");
  return {
    ymd,
    label: relativeDayLabel(ymd, localYmd(now, tz)),
    load,
    blocks: [...blocks, ...suggestions].sort((a, b) => a.start.getTime() - b.start.getTime()),
    unscheduled: unscheduledTasks
      .filter((t) => !suggestions.some((s) => s.id === t.id))
      .map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt, durationMinutes: t.durationMinutes, priority: t.priority })),
    notes,
  };
}

export { occurrenceEnd };
