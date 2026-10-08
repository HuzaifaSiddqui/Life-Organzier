import { Prisma, TaskStatus, type CheckinLog, type Task, type UserSettings } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { HttpError } from "../../lib/http.js";
import { formatClock, instantLabel, localParts, localYmd } from "../../lib/time.js";
import { logEvent } from "../events/eventService.js";
import { latestMood } from "../mood/moodService.js";
import { loadScheduleContext, suggestSlot, type SlotSuggestion } from "../scheduling/schedulingService.js";
import { getTaskForUser, serializeTask, updateTask, type SerializedTask, type TaskContext } from "../tasks/taskService.js";
import { applyDailyCap, chooseTone, planTaskCheckins, requestExtraCheckin, type CheckinHistory, type CheckinKind } from "./checkinPlanner.js";
import {
  buildCopy,
  copyLanguage,
  durationLabel,
  isCopyStale,
  messageFor,
  modelFirstStep,
  refreshCheckinCopy,
  renderAck,
  shortTitle,
  templateCopy,
  type CheckinCopy,
} from "./copy.js";
import { RESPONSE_TEXT, type CopyKind, type Lang } from "./templates.js";

/**
 * FR-RN-004 integration: turns the pure planner + pre-written copy into persisted CheckinLog rows
 * the phone schedules, and applies the user's responses.
 */

export type PlannedCheckinOut = {
  id: string;
  taskId: string;
  kind: CheckinKind;
  /** START → Started / Not today · COMPLETION → Done / +30 min / Update… */
  category: "START" | "COMPLETION";
  fireAt: string;
  title: string;
  body: string;
  tone: string;
  offerSplit: boolean;
};

const ACTIVE = [TaskStatus.PENDING, TaskStatus.IN_PROGRESS];
const RETRY_LEAD_MS = 30 * 60000;
const MAX_RETRIES = 2;

function fill(text: string, slots: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, k: string) => String(slots[k] ?? ""));
}

function responseText(lang: Lang, key: string, task: Pick<Task, "title">, slots: Record<string, string | number> = {}): string {
  return fill(RESPONSE_TEXT[lang][key], { task: lang === "ur" ? `⁨${shortTitle(task.title)}⁩` : shortTitle(task.title), ...slots });
}

function copyKindFor(kind: CheckinKind, unconfirmed: boolean): CopyKind {
  if (kind === "START" || kind === "START_FOLLOWUP") return kind;
  return unconfirmed ? "COMPLETION_UNCONFIRMED" : "COMPLETION";
}

/** Stable 50/50 for research mode, decided per check-in so re-planning doesn't flip it. */
export function researchIncludesStep(key: string): boolean {
  let h = 2166136261;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (Math.abs(h) & 1) === 0;
}

function toHistory(rows: CheckinLog[]): CheckinHistory[] {
  return rows.map((r) => ({ kind: r.kind, fireAt: r.fireAt, slotStart: r.slotStart, status: r.status, response: r.response }));
}

/* ---------------------------------------------------------------------------- copy + retry */

const retrying = new Set<string>();

/**
 * When a slot's first step came from the library (or none) and the start is > 30 min away, ask
 * Gemini again in the background — max 2 times per slot. Saved only if the slot is unchanged and
 * the step passes validation (modelFirstStep validates).
 */
export function queueFirstStepRetry(task: Task, settings: Pick<UserSettings, "language" | "checkinTone">, now = new Date()): boolean {
  const copy = task.checkinCopy as CheckinCopy | null;
  if (!task.scheduledStart || !copy || (copy.firstStepSource !== "LIBRARY" && copy.firstStepSource !== "NONE")) return false;
  if (task.scheduledStart.getTime() - now.getTime() <= RETRY_LEAD_MS || (copy.retries ?? 0) >= MAX_RETRIES) return false;
  const key = `${task.id}:${task.scheduledStart.toISOString()}`;
  if (retrying.has(key)) return false;
  retrying.add(key);
  const slot = task.scheduledStart;
  const save = (c: CheckinCopy) => prisma.task.updateMany({ where: { id: task.id, scheduledStart: slot }, data: { checkinCopy: c as unknown as Prisma.InputJsonValue } });
  void (async () => {
    try {
      const retries = (copy.retries ?? 0) + 1;
      await save({ ...copy, retries }); // count the attempt even if it fails
      const step = await modelFirstStep("gemini", task, copyLanguage(settings.language));
      if (step) await save({ ...buildCopy(task, settings, step, "GEMINI", now), retries });
    } catch (error) {
      console.warn("Check-in first-step retry failed", error instanceof Error ? error.message : error);
    } finally {
      retrying.delete(key);
    }
  })();
  return true;
}

function currentCopy(task: Task, settings: UserSettings, now: Date): CheckinCopy {
  if (isCopyStale(task.checkinCopy, task, settings)) {
    refreshCheckinCopy(task); // stored copy is for another slot/style/language: rewrite in the background
    return templateCopy(task, settings, now);
  }
  queueFirstStepRetry(task, settings, now);
  return task.checkinCopy as unknown as CheckinCopy;
}

/* ---------------------------------------------------------------------------- plan */

async function upsertRow(
  data: Omit<Prisma.CheckinLogUncheckedCreateInput, "id" | "status">,
): Promise<CheckinLog> {
  const where = { taskId_kind_fireAt: { taskId: data.taskId as string, kind: data.kind, fireAt: data.fireAt as Date } };
  let existing = await prisma.checkinLog.findUnique({ where });
  if (!existing) {
    try {
      return await prisma.checkinLog.create({ data: { ...data, status: "SCHEDULED" } });
    } catch (error) {
      // Two plan requests at once: the other one created it first.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
      existing = await prisma.checkinLog.findUnique({ where });
      if (!existing) throw error;
    }
  }
  if (existing.status === "ANSWERED" || existing.status === "IGNORED") return existing;
  return prisma.checkinLog.update({
    where: { id: existing.id },
    data: { status: "SCHEDULED", tone: data.tone, message: data.message, hasFirstStep: data.hasFirstStep, copySource: data.copySource, moodAtPlan: data.moodAtPlan },
  });
}

function out(row: CheckinLog, task: Task, offerSplit: boolean): PlannedCheckinOut {
  return {
    id: row.id,
    taskId: task.id,
    kind: row.kind as CheckinKind,
    category: row.kind === "START" || row.kind === "START_FOLLOWUP" ? "START" : "COMPLETION",
    fireAt: row.fireAt.toISOString(),
    title: task.title,
    body: row.message,
    tone: row.tone,
    offerSplit,
  };
}

/**
 * Builds and persists the user's upcoming check-ins (FR-RN-004 §2–5). Rows keep stable ids across
 * re-plans (upsert on task+kind+fireAt); rows that drop out of the plan are cancelled, not deleted.
 */
export async function planCheckins(userId: string, settings: UserSettings, now = new Date(), horizonDays = 7): Promise<PlannedCheckinOut[]> {
  const tz = settings.timezone;
  const horizon = new Date(now.getTime() + horizonDays * 86400000);
  const tasks = await prisma.task.findMany({
    where: { userId, status: { in: ACTIVE }, archived: false, scheduledStart: { not: null, gte: new Date(now.getTime() - 86400000), lte: horizon } },
  });
  const rows = tasks.length ? await prisma.checkinLog.findMany({ where: { userId, taskId: { in: tasks.map((t) => t.id) } } }) : [];
  const byTask = new Map<string, CheckinLog[]>();
  for (const r of rows) if (r.taskId) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  const dnd = settings.dndUntil && settings.dndUntil > now ? settings.dndUntil : null;
  const mood = await latestMood(userId, 24);
  const tone = chooseTone(settings.checkinTone, mood, now);

  // Planned check-ins that already fired today count toward the daily cap.
  const firedByDay = new Map<string, number>();
  for (const r of rows) {
    if (r.kind !== "COMPLETION_EXTRA" && r.status !== "CANCELLED" && r.fireAt <= now) {
      const day = localYmd(r.fireAt, tz);
      firedByDay.set(day, (firedByDay.get(day) ?? 0) + 1);
    }
  }
  const candidates = tasks.flatMap((task) =>
    planTaskCheckins(task, settings, tz, now, dnd, toHistory(byTask.get(task.id) ?? [])).map((c) => ({ ...c, task })),
  );
  const kept = applyDailyCap(candidates, tz, firedByDay);

  const result: PlannedCheckinOut[] = [];
  const keepIds = new Set<string>();
  for (const c of kept) {
    const copy = currentCopy(c.task, settings, now);
    const copyKind = copyKindFor(c.kind, c.unconfirmed);
    const key = `${c.task.id}:${c.kind}:${c.fireAt.toISOString()}`;
    const include = !settings.checkinResearchMode || researchIncludesStep(key);
    const msg = messageFor(copy, copyKind, tone.tone, c.task, include);
    const row = await upsertRow({
      userId,
      taskId: c.task.id,
      slotStart: c.task.scheduledStart as Date,
      kind: c.kind,
      fireAt: c.fireAt,
      tone: tone.tone,
      hasFirstStep: msg.hasFirstStep,
      // Research mode: a first step existed but this message deliberately omits it.
      copySource: msg.hasFirstStep ? copy.firstStepSource : copy.firstStep && !include && (copyKind === "START" || copyKind === "START_FOLLOWUP") ? "WITHHELD" : "NONE",
      moodAtPlan: mood?.mood ?? null,
      message: msg.text,
    });
    keepIds.add(row.id);
    if (row.status === "SCHEDULED") result.push(out(row, c.task, tone.offerSplit));
  }

  // User-requested extra time is exempt from the caps and stays as created.
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  for (const r of rows) {
    const task = r.taskId ? taskById.get(r.taskId) : undefined;
    if (r.kind === "COMPLETION_EXTRA" && r.status === "SCHEDULED" && r.fireAt > now && task && r.slotStart.getTime() === task.scheduledStart?.getTime()) {
      keepIds.add(r.id);
      result.push(out(r, task, tone.offerSplit));
    }
  }
  await prisma.checkinLog.updateMany({
    where: { userId, status: "SCHEDULED", fireAt: { gt: now }, kind: { not: "COMPLETION_EXTRA" }, id: { notIn: [...keepIds] } },
    data: { status: "CANCELLED" },
  });
  return result.sort((a, b) => a.fireAt.localeCompare(b.fireAt));
}

/** Maintenance: check-ins that fired more than 2 h ago without an answer are IGNORED. */
export async function expireCheckins(now = new Date()): Promise<number> {
  const r = await prisma.checkinLog.updateMany({ where: { status: "SCHEDULED", fireAt: { lt: new Date(now.getTime() - 2 * 3600000) } }, data: { status: "IGNORED" } });
  return r.count;
}

/* ---------------------------------------------------------------------------- respond */

export const START_RESPONSES = ["STARTED", "NOT_TODAY"] as const;
export const COMPLETION_RESPONSES = ["DONE", "PLUS_30", "MORE_15", "MORE_60", "PARTIAL_25", "PARTIAL_50", "PARTIAL_75", "DIDNT"] as const;
export const CHECKIN_RESPONSES = [...START_RESPONSES, ...COMPLETION_RESPONSES] as const;
export type CheckinResponse = (typeof CHECKIN_RESPONSES)[number];

export function responseAllowed(kind: string, response: CheckinResponse): boolean {
  const start = kind === "START" || kind === "START_FOLLOWUP";
  return start ? (START_RESPONSES as readonly string[]).includes(response) : (COMPLETION_RESPONSES as readonly string[]).includes(response);
}

export function extraMinutes(response: CheckinResponse): number | null {
  return response === "PLUS_30" ? 30 : response === "MORE_15" ? 15 : response === "MORE_60" ? 60 : null;
}

export function partialPercent(response: CheckinResponse): number | null {
  const m = response.match(/^PARTIAL_(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** Minutes still needed after a partial completion (never below 15). */
export function remainingMinutes(durationMinutes: number | null, progress: number): number {
  return Math.max(15, Math.round((durationMinutes ?? 60) * (1 - progress / 100)));
}

export type RespondResult = {
  checkin: { id: string; status: string; response: string | null };
  task: SerializedTask | null;
  message: string | null;
  /** The check-in the phone should schedule now (completion after "Started", or extra time). */
  next: PlannedCheckinOut | null;
  /** Reschedule / plan-the-rest suggestion; the user decides (never applied automatically). */
  suggestion: SlotSuggestion | null;
  remainingMinutes: number | null;
  deadlineWarning: boolean;
  refused: "limit" | "quiet_hours" | "dnd" | null;
  alreadyAnswered: boolean;
};

async function slotFor(userId: string, settings: UserSettings, task: Task, minutes: number, now: Date): Promise<SlotSuggestion | null> {
  const ctx = await loadScheduleContext(userId, settings, 14);
  return suggestSlot(ctx, { durationMinutes: minutes, priority: task.priority, difficulty: task.difficulty, deadline: task.dueAt, excludeTaskId: task.id }, now);
}

/** Tap time from the phone (offline queue may deliver late), clamped to [fireAt, now]. */
export function clampTapTime(respondedAt: Date | null | undefined, fireAt: Date, now: Date): Date {
  if (!respondedAt || Number.isNaN(respondedAt.getTime())) return now;
  return new Date(Math.min(now.getTime(), Math.max(fireAt.getTime(), respondedAt.getTime())));
}

export async function respondToCheckin(
  userId: string,
  settings: UserSettings,
  ctx: TaskContext,
  checkinId: string,
  response: CheckinResponse,
  now = new Date(),
  respondedAt?: Date | null,
): Promise<RespondResult> {
  const row = await prisma.checkinLog.findFirst({ where: { id: checkinId, userId } });
  if (!row) throw new HttpError(404, "CHECKIN_NOT_FOUND", "Check-in not found");
  if (!responseAllowed(row.kind, response)) throw new HttpError(400, "INVALID_RESPONSE", `${response} is not a valid answer to a ${row.kind} check-in`);
  const lang = copyLanguage(settings.language);
  const at = clampTapTime(respondedAt, row.fireAt, now);
  const base: RespondResult = {
    checkin: { id: row.id, status: row.status, response: row.response },
    task: null,
    message: null,
    next: null,
    suggestion: null,
    remainingMinutes: null,
    deadlineWarning: false,
    refused: null,
    alreadyAnswered: false,
  };
  let task = row.taskId ? await getTaskForUser(userId, row.taskId) : null;

  // Atomic claim: concurrent or repeated answers (offline queue retries) are applied exactly once.
  const claimed = await prisma.checkinLog.updateMany({ where: { id: row.id, userId, status: { not: "ANSWERED" } }, data: { status: "ANSWERED", response, respondedAt: at } });
  if (claimed.count === 0) {
    const current = await prisma.checkinLog.findUnique({ where: { id: row.id } });
    return { ...base, checkin: { id: row.id, status: "ANSWERED", response: current?.response ?? null }, task: task ? serializeTask(task, now) : null, alreadyAnswered: true };
  }
  const answered = { id: row.id, status: "ANSWERED", response };
  logEvent(userId, "CHECKIN_RESPONSE", row.taskId, { kind: row.kind, response, tone: row.tone, hasFirstStep: row.hasFirstStep, copySource: row.copySource, minutes: Math.round((at.getTime() - row.fireAt.getTime()) / 60000), stale: row.status === "CANCELLED" });
  if (!task || task.status === TaskStatus.DELETED) return { ...base, checkin: answered };

  // Stale answers (old slot, or the task was already finished in the app) are recorded but change nothing.
  if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.SKIPPED) {
    return { ...base, checkin: answered, task: serializeTask(task, now), message: RESPONSE_TEXT[lang].STALE_DONE };
  }
  if (row.status === "CANCELLED") {
    return { ...base, checkin: answered, task: serializeTask(task, now), message: responseText(lang, "STALE", task) };
  }

  const result: RespondResult = { ...base, checkin: answered };
  const extra = extraMinutes(response);
  const partial = partialPercent(response);

  if (response === "STARTED") {
    const hadStarted = Boolean(task.startedAt);
    task = (await updateTask(ctx, task.id, { status: TaskStatus.IN_PROGRESS })) ?? task;
    if (!hadStarted) task = await prisma.task.update({ where: { id: task.id }, data: { startedAt: at } });
    const plan = await planCheckins(userId, settings, now);
    result.next = plan.find((c) => c.taskId === task!.id && c.kind === "COMPLETION") ?? null;
    result.message = responseText(lang, "STARTED", task);
  } else if (response === "NOT_TODAY") {
    result.suggestion = await slotFor(userId, settings, task, task.durationMinutes ?? 60, now);
    result.message = responseText(lang, "NOT_TODAY", task);
  } else if (response === "DONE") {
    task = (await updateTask(ctx, task.id, { status: TaskStatus.COMPLETED })) ?? task;
    if (task.status === TaskStatus.COMPLETED) task = await prisma.task.update({ where: { id: task.id }, data: { completedAt: at } });
    result.message = renderAck("DONE", lang, task);
  } else if (response === "DIDNT") {
    result.suggestion = await slotFor(userId, settings, task, task.durationMinutes ?? 60, now);
    result.message = renderAck("DIDNT", lang, task);
  } else if (partial !== null) {
    task = (await updateTask(ctx, task.id, { progress: Math.max(task.progress, partial) })) ?? task;
    result.remainingMinutes = remainingMinutes(task.durationMinutes, task.progress);
    result.suggestion = await slotFor(userId, settings, task, result.remainingMinutes, now);
    result.message = responseText(lang, "PARTIAL", task, { progress: task.progress, remaining: durationLabel(result.remainingMinutes, lang) });
  } else if (extra !== null) {
    const history = toHistory(await prisma.checkinLog.findMany({ where: { taskId: task.id } }));
    const dnd = settings.dndUntil && settings.dndUntil > now ? settings.dndUntil : null;
    const r = requestExtraCheckin(extra, task, settings, settings.timezone, at, dnd, history);
    if (!r.ok) {
      result.refused = r.reason;
      result.remainingMinutes = remainingMinutes(task.durationMinutes, task.progress);
      result.suggestion = await slotFor(userId, settings, task, result.remainingMinutes, now);
      result.message = responseText(lang, r.reason === "limit" ? "REFUSED_LIMIT" : r.reason === "dnd" ? "REFUSED_DND" : "REFUSED_QUIET", task);
    } else {
      const copy = currentCopy(task, settings, now);
      const tone = chooseTone(settings.checkinTone, await latestMood(userId, 24), now);
      const msg = messageFor(copy, "COMPLETION", tone.tone, task);
      const created = await upsertRow({
        userId,
        taskId: task.id,
        slotStart: task.scheduledStart ?? row.slotStart,
        kind: "COMPLETION_EXTRA",
        fireAt: r.fireAt,
        tone: tone.tone,
        hasFirstStep: false,
        copySource: "NONE",
        moodAtPlan: null,
        message: msg.text,
      });
      result.next = out(created, task, tone.offerSplit);
      result.deadlineWarning = r.passesDeadline;
      const p = localParts(r.fireAt, settings.timezone);
      result.message = r.passesDeadline && task.dueAt
        ? renderAck("DEADLINE_WARNING", lang, task, instantLabel(task.dueAt, settings.timezone, at))
        : responseText(lang, "EXTRA_OK", task, { time: formatClock(p.h, p.mi) });
      if (r.passesDeadline) {
        result.remainingMinutes = remainingMinutes(task.durationMinutes, task.progress);
        result.suggestion = await slotFor(userId, settings, task, result.remainingMinutes, now);
      }
    }
  }
  return { ...result, task: serializeTask(task, now) };
}
