import {
  Prisma,
  RoutineFrequency,
  RoutineOccurrenceStatus,
  RoutinePriority,
  type Routine,
  type RoutineOccurrence,
} from "@prisma/client";
import { prisma } from "../../config/db.js";
import { HttpError } from "../../lib/http.js";
import { addDaysYmd, diffDaysYmd, formatClock, inWindow, localYmd, minutesOfDay, parseClock, startOfLocalDay, weekdayOfYmd, zonedTimeToUtc } from "../../lib/time.js";
import { logEvent } from "../events/eventService.js";
import { getPatterns, peakWindowsFrom } from "../patterns/patternService.js";

export type RoutineInput = {
  title: string;
  description?: string | null;
  frequency: RoutineFrequency;
  daysOfWeek?: number[] | null;
  dayOfMonth?: number | null;
  dueTime?: string | null;
  durationMinutes?: number | null;
  category?: string | null;
  priority?: RoutinePriority;
  timeLocked?: boolean;
  locationContext?: string | null;
  /** Room or venue of a class, as written in the source document. */
  location?: string | null;
  wellnessType?: string | null;
  active?: boolean;
  /** Every N days (2..30) from anchorDate (local YYYY-MM-DD); null keeps frequency/days. */
  intervalDays?: number | null;
  anchorDate?: string | null;
  /** The user chose "no reminder": the routine keeps no time (flexible). Otherwise a missing time gets the default. */
  noReminder?: boolean;
};

/** With no learned peak hours, a routine's default reminder is at 9 AM. */
export const DEFAULT_ROUTINE_HOUR = 9;

/** The default hour, moved to the end of quiet hours when it falls inside them (22:00–08:00 → 8 AM). */
export function defaultRoutineHour(peakStartHour: number | null | undefined, quietStart: string | null, quietEnd: string | null): number {
  const hour = peakStartHour ?? DEFAULT_ROUTINE_HOUR;
  const start = minutesOfDay(parseClock(quietStart) ?? { h: 22, m: 0 });
  const end = minutesOfDay(parseClock(quietEnd) ?? { h: 8, m: 0 });
  return inWindow(hour * 60, start, end) ? Math.ceil(end / 60) % 24 : hour;
}

/** A routine made without a time gets one: the user's peak start hour (9 if unknown), never inside quiet hours. */
export async function defaultRoutineTime(userId: string, tz: string): Promise<string> {
  const [settings, patterns] = await Promise.all([prisma.userSettings.findUnique({ where: { userId } }), getPatterns(userId, tz)]);
  const peak = peakWindowsFrom(patterns).windows[0]?.start;
  return formatClock(defaultRoutineHour(peak, settings?.quietStart ?? null, settings?.quietEnd ?? null), 0);
}

export const MAX_INTERVAL_DAYS = 30;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Every N days: a day counts when its distance in days from the anchor is a non-negative multiple of N.
 * Calendar-day arithmetic on YYYY-MM-DD (the user's local dates), so month ends and DST don't shift it.
 */
export function intervalMatches(anchorYmd: string, intervalDays: number, ymd: string): boolean {
  const d = diffDaysYmd(anchorYmd, ymd);
  return d >= 0 && d % intervalDays === 0;
}

export type OccurrenceWithRoutine = RoutineOccurrence & { routine: Routine };

const GENERATE_DAYS = 14;

export function routineMatchesDay(routine: Pick<Routine, "frequency" | "daysOfWeek" | "dayOfMonth"> & Partial<Pick<Routine, "intervalDays" | "anchorDate">>, ymd: string): boolean {
  if (routine.intervalDays && routine.anchorDate) return intervalMatches(routine.anchorDate, routine.intervalDays, ymd);
  const weekday = weekdayOfYmd(ymd);
  const days = Array.isArray(routine.daysOfWeek) ? (routine.daysOfWeek as unknown[]).map(Number) : [];
  switch (routine.frequency) {
    case RoutineFrequency.DAILY:
      return true;
    case RoutineFrequency.WEEKLY:
    case RoutineFrequency.CUSTOM:
      return days.includes(weekday);
    case RoutineFrequency.MONTHLY:
      return routine.dayOfMonth === Number(ymd.slice(8, 10));
    default:
      return false;
  }
}

/** Start instant of an occurrence (its local due time, or the start of its day when untimed). */
export function occurrenceStart(o: Pick<RoutineOccurrence, "occurrenceDate" | "dueTime">, tz: string): Date {
  const ymd = localYmd(o.occurrenceDate, tz);
  const clock = parseClock(o.dueTime) ?? { h: 0, m: 0 };
  return zonedTimeToUtc(ymd, clock.h, clock.m, tz);
}

export function occurrenceEnd(o: OccurrenceWithRoutine, tz: string): Date {
  const start = occurrenceStart(o, tz);
  if (!parseClock(o.dueTime)) return zonedTimeToUtc(addDaysYmd(localYmd(o.occurrenceDate, tz), 1), 0, 0, tz);
  return new Date(start.getTime() + (o.routine.durationMinutes ?? 30) * 60000);
}

function visibleInContext(routine: Pick<Routine, "locationContext">, context: string | null | undefined): boolean {
  return !context || !routine.locationContext || routine.locationContext === context;
}

/** `now`: the caller's clock (the chat passes the turn's), so the occurrence window and the rest of the turn agree. */
export async function listRoutines(userId: string, tz: string, context?: string | null, now = new Date()) {
  const today = startOfLocalDay(localYmd(now, tz), tz);
  const routines = await prisma.routine.findMany({
    where: { userId },
    include: {
      occurrences: {
        where: { occurrenceDate: { gte: new Date(today.getTime() - 14 * 86400000), lte: new Date(today.getTime() + 8 * 86400000) } },
        orderBy: { occurrenceDate: "asc" },
      },
    },
    orderBy: [{ priority: "asc" }, { dueTime: "asc" }, { createdAt: "desc" }],
  });
  return routines.filter((r) => visibleInContext(r, context));
}

function validate(input: RoutineInput): void {
  if (input.intervalDays != null) {
    if (!Number.isInteger(input.intervalDays) || input.intervalDays < 2 || input.intervalDays > MAX_INTERVAL_DAYS) {
      throw new HttpError(400, "VALIDATION_ERROR", `Repeat every 2 to ${MAX_INTERVAL_DAYS} days`);
    }
    if (!input.anchorDate || !YMD.test(input.anchorDate)) throw new HttpError(400, "VALIDATION_ERROR", "Pick a start date for a routine that repeats every few days");
    return validateTime(input);
  }
  if ((input.frequency === RoutineFrequency.WEEKLY || input.frequency === RoutineFrequency.CUSTOM) && !input.daysOfWeek?.length) {
    throw new HttpError(400, "VALIDATION_ERROR", "Pick at least one day for weekly routines");
  }
  if (input.frequency === RoutineFrequency.MONTHLY && !input.dayOfMonth) {
    throw new HttpError(400, "VALIDATION_ERROR", "Pick a day of the month for monthly routines");
  }
  validateTime(input);
}

function validateTime(input: RoutineInput): void {
  if (input.dueTime && !parseClock(input.dueTime)) throw new HttpError(400, "VALIDATION_ERROR", "Invalid routine time");
}

export async function createRoutine(userId: string, tz: string, input: RoutineInput, now = new Date()): Promise<Routine> {
  validate(input);
  // Every routine gets a reminder time unless the user said "no reminder" (chat, form, documents alike).
  const dueTime = input.dueTime ?? (input.noReminder ? null : await defaultRoutineTime(userId, tz));
  const routine = await prisma.routine.create({
    data: {
      userId,
      title: input.title.trim().slice(0, 200),
      description: input.description ?? null,
      frequency: input.frequency,
      daysOfWeek: input.daysOfWeek?.length ? input.daysOfWeek : Prisma.JsonNull,
      dayOfMonth: input.dayOfMonth ?? null,
      dueTime,
      durationMinutes: input.durationMinutes ?? null,
      category: input.category ?? null,
      priority: input.priority ?? RoutinePriority.NORMAL,
      timeLocked: input.timeLocked ?? false,
      locationContext: input.locationContext ?? null,
      location: input.location?.trim() || null,
      wellnessType: input.wellnessType ?? null,
      intervalDays: input.intervalDays ?? null,
      anchorDate: input.intervalDays ? (input.anchorDate ?? null) : null,
    },
  });
  await generateRoutineOccurrences(userId, tz, GENERATE_DAYS, now);
  return routine;
}

/**
 * "I already took it today": today's occurrence is marked done. It exists from generation (one row per routine
 * and day, unique), so this updates that row, or creates it if today doesn't match the schedule; never a second one.
 */
export async function markTodayDone(userId: string, tz: string, routineId: string, now = new Date()): Promise<RoutineOccurrence> {
  const routine = await prisma.routine.findFirstOrThrow({ where: { id: routineId, userId } });
  const occurrenceDate = startOfLocalDay(localYmd(now, tz), tz);
  const done = { status: RoutineOccurrenceStatus.COMPLETED, completedAt: now };
  const row = await prisma.routineOccurrence.upsert({
    where: { routineId_occurrenceDate: { routineId, occurrenceDate } },
    update: done,
    create: { routineId, userId, occurrenceDate, dueTime: routine.dueTime, ...done },
  });
  logEvent(userId, "ROUTINE_COMPLETED", routineId, { title: routine.title, category: routine.category });
  return row;
}

export async function updateRoutine(userId: string, tz: string, id: string, changes: Partial<RoutineInput>, now = new Date()): Promise<Routine | null> {
  // "No reminder" on an existing routine clears its time.
  const { noReminder, ...rest } = changes;
  const input: Partial<RoutineInput> = noReminder ? { ...rest, dueTime: null } : rest;
  const existing = await prisma.routine.findFirst({ where: { id, userId } });
  if (!existing) return null;
  // The form's reminder switch turned back on without a time: the default time, as for a new routine.
  if (noReminder === false && !(input.dueTime !== undefined ? input.dueTime : existing.dueTime)) input.dueTime = await defaultRoutineTime(userId, tz);
  // New weekdays or frequency without an interval: the routine follows those (the interval is dropped). Compared
  // with what is stored, not by presence: the routine form resends the whole schedule on every save.
  const days = (d: unknown) => (Array.isArray(d) ? [...(d as number[])].sort().join(",") : "");
  const scheduleChanged =
    (input.frequency !== undefined && input.frequency !== existing.frequency) ||
    (input.daysOfWeek !== undefined && days(input.daysOfWeek) !== days(existing.daysOfWeek)) ||
    (input.dayOfMonth !== undefined && (input.dayOfMonth ?? null) !== existing.dayOfMonth);
  const intervalDays = input.intervalDays !== undefined ? input.intervalDays : scheduleChanged ? null : existing.intervalDays;
  const anchorDate = intervalDays ? (input.anchorDate !== undefined ? input.anchorDate : existing.anchorDate) : null;
  const merged: RoutineInput = {
    title: input.title ?? existing.title,
    frequency: input.frequency ?? existing.frequency,
    daysOfWeek: input.daysOfWeek !== undefined ? input.daysOfWeek : (existing.daysOfWeek as number[] | null),
    dayOfMonth: input.dayOfMonth !== undefined ? input.dayOfMonth : existing.dayOfMonth,
    dueTime: input.dueTime !== undefined ? input.dueTime : existing.dueTime,
    intervalDays,
    anchorDate,
  };
  validate(merged);
  const routine = await prisma.routine.update({
    where: { id },
    data: {
      ...input,
      daysOfWeek: input.daysOfWeek === undefined ? undefined : input.daysOfWeek?.length ? input.daysOfWeek : Prisma.JsonNull,
      intervalDays,
      anchorDate,
    },
  });
  // Future pending occurrences follow the new schedule.
  const todayStart = startOfLocalDay(localYmd(now, tz), tz);
  await prisma.routineOccurrence.deleteMany({
    where: { routineId: id, status: RoutineOccurrenceStatus.PENDING, occurrenceDate: { gte: todayStart } },
  });
  await generateRoutineOccurrences(userId, tz, GENERATE_DAYS, now);
  return routine;
}

export async function deleteRoutine(userId: string, id: string): Promise<boolean> {
  const result = await prisma.routine.deleteMany({ where: { id, userId } });
  return result.count > 0;
}

/** Ensures occurrences exist for the next 14 local days — one batched insert. */
export async function generateRoutineOccurrences(userId: string, tz: string, days = GENERATE_DAYS, now = new Date()): Promise<number> {
  const routines = await prisma.routine.findMany({ where: { userId, active: true } });
  if (!routines.length) return 0;
  const today = localYmd(now, tz);
  const rows: Prisma.RoutineOccurrenceCreateManyInput[] = [];
  for (const routine of routines) {
    const createdYmd = localYmd(routine.createdAt, tz);
    for (let i = 0; i <= days; i += 1) {
      const ymd = addDaysYmd(today, i);
      if (ymd < createdYmd || !routineMatchesDay(routine, ymd)) continue;
      rows.push({ routineId: routine.id, userId, occurrenceDate: startOfLocalDay(ymd, tz), dueTime: routine.dueTime });
    }
  }
  if (!rows.length) return 0;
  const result = await prisma.routineOccurrence.createMany({ data: rows, skipDuplicates: true });
  return result.count;
}

/**
 * Missed routine handling (FR-RM-003): time-locked occurrences whose slot has passed are marked
 * MISSED (never moved to another time). Flexible ones stay pending so the user can decide.
 */
export async function markMissedOccurrences(userId: string, tz: string, now = new Date()): Promise<OccurrenceWithRoutine[]> {
  const pending = await prisma.routineOccurrence.findMany({
    where: { userId, status: RoutineOccurrenceStatus.PENDING, occurrenceDate: { lt: now } },
    include: { routine: true },
  });
  const missed = pending.filter((o) => o.routine.timeLocked && occurrenceEnd(o, tz).getTime() + 30 * 60000 < now.getTime());
  if (!missed.length) return [];
  await prisma.routineOccurrence.updateMany({
    where: { id: { in: missed.map((o) => o.id) }, status: RoutineOccurrenceStatus.PENDING },
    data: { status: RoutineOccurrenceStatus.MISSED },
  });
  for (const o of missed) logEvent(userId, "ROUTINE_MISSED", o.routineId, { title: o.routine.title });
  return missed.map((o) => ({ ...o, status: RoutineOccurrenceStatus.MISSED }));
}

export async function updateOccurrence(
  userId: string,
  occurrenceId: string,
  status: RoutineOccurrenceStatus,
  opts: { confirmMandatory?: boolean } = {},
): Promise<OccurrenceWithRoutine | null> {
  const occurrence = await prisma.routineOccurrence.findFirst({ where: { id: occurrenceId, userId }, include: { routine: true } });
  if (!occurrence) return null;
  if (status === RoutineOccurrenceStatus.SKIPPED && occurrence.routine.priority === RoutinePriority.MANDATORY && !opts.confirmMandatory) {
    throw new HttpError(409, "MANDATORY_CONFIRMATION_REQUIRED", `"${occurrence.routine.title}" is mandatory. Are you sure you want to skip it?`);
  }
  const updated = await prisma.routineOccurrence.update({
    where: { id: occurrenceId },
    data: { status, completedAt: status === RoutineOccurrenceStatus.COMPLETED ? new Date() : null },
    include: { routine: true },
  });
  if (status === RoutineOccurrenceStatus.COMPLETED) {
    logEvent(userId, "ROUTINE_COMPLETED", occurrence.routineId, { title: occurrence.routine.title, category: occurrence.routine.category });
  } else if (status === RoutineOccurrenceStatus.SKIPPED) {
    logEvent(userId, "ROUTINE_SKIPPED", occurrence.routineId, {
      title: occurrence.routine.title,
      mandatory: occurrence.routine.priority === RoutinePriority.MANDATORY,
    });
  }
  return updated;
}

/** Moves a flexible occurrence to another day/time (user-confirmed, FR-RM-003 §2). */
export async function rescheduleOccurrence(userId: string, tz: string, occurrenceId: string, ymd: string, time: string | null) {
  const occurrence = await prisma.routineOccurrence.findFirst({ where: { id: occurrenceId, userId }, include: { routine: true } });
  if (!occurrence) return null;
  if (occurrence.routine.timeLocked) {
    throw new HttpError(400, "ROUTINE_TIME_LOCKED", "Time-locked routines can't be moved — the next occurrence is already scheduled.");
  }
  const target = startOfLocalDay(ymd, tz);
  const clash = await prisma.routineOccurrence.findFirst({
    where: { routineId: occurrence.routineId, occurrenceDate: target, NOT: { id: occurrenceId } },
  });
  if (clash) {
    await prisma.routineOccurrence.delete({ where: { id: occurrenceId } });
    return prisma.routineOccurrence.update({ where: { id: clash.id }, data: { dueTime: time ?? clash.dueTime }, include: { routine: true } });
  }
  return prisma.routineOccurrence.update({
    where: { id: occurrenceId },
    data: { occurrenceDate: target, dueTime: time ?? occurrence.dueTime, status: RoutineOccurrenceStatus.PENDING },
    include: { routine: true },
  });
}

export async function occurrencesBetween(userId: string, from: Date, to: Date, context?: string | null): Promise<OccurrenceWithRoutine[]> {
  const list = await prisma.routineOccurrence.findMany({
    where: { userId, occurrenceDate: { gte: new Date(from.getTime() - 86400000), lt: to }, routine: { active: true } },
    include: { routine: true },
    orderBy: [{ occurrenceDate: "asc" }, { dueTime: "asc" }],
  });
  return list.filter((o) => visibleInContext(o.routine, context));
}

export async function occurrencesForDay(userId: string, tz: string, ymd: string, context?: string | null): Promise<OccurrenceWithRoutine[]> {
  const start = startOfLocalDay(ymd, tz);
  const list = await occurrencesBetween(userId, start, startOfLocalDay(addDaysYmd(ymd, 1), tz), context);
  return list.filter((o) => localYmd(o.occurrenceDate, tz) === ymd);
}

/** Mandatory routines overlapping [start, end) (FR-RM-002 §3). */
export async function mandatoryConflicts(userId: string, tz: string, start: Date, end: Date): Promise<OccurrenceWithRoutine[]> {
  const list = await occurrencesBetween(userId, start, new Date(end.getTime() + 86400000));
  return list.filter((o) => {
    if (o.routine.priority !== RoutinePriority.MANDATORY || !parseClock(o.dueTime) || o.status !== RoutineOccurrenceStatus.PENDING) return false;
    const s = occurrenceStart(o, tz);
    const e = occurrenceEnd(o, tz);
    return s < end && e > start;
  });
}
