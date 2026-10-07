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
import { addDaysYmd, localYmd, parseClock, startOfLocalDay, weekdayOfYmd, zonedTimeToUtc } from "../../lib/time.js";
import { logEvent } from "../events/eventService.js";

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
  wellnessType?: string | null;
  active?: boolean;
};

export type OccurrenceWithRoutine = RoutineOccurrence & { routine: Routine };

const GENERATE_DAYS = 14;

export function routineMatchesDay(routine: Pick<Routine, "frequency" | "daysOfWeek" | "dayOfMonth">, ymd: string): boolean {
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

export async function listRoutines(userId: string, tz: string, context?: string | null) {
  const today = startOfLocalDay(localYmd(new Date(), tz), tz);
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
  if ((input.frequency === RoutineFrequency.WEEKLY || input.frequency === RoutineFrequency.CUSTOM) && !input.daysOfWeek?.length) {
    throw new HttpError(400, "VALIDATION_ERROR", "Pick at least one day for weekly routines");
  }
  if (input.frequency === RoutineFrequency.MONTHLY && !input.dayOfMonth) {
    throw new HttpError(400, "VALIDATION_ERROR", "Pick a day of the month for monthly routines");
  }
  if (input.dueTime && !parseClock(input.dueTime)) throw new HttpError(400, "VALIDATION_ERROR", "Invalid routine time");
}

export async function createRoutine(userId: string, tz: string, input: RoutineInput): Promise<Routine> {
  validate(input);
  const routine = await prisma.routine.create({
    data: {
      userId,
      title: input.title.trim().slice(0, 200),
      description: input.description ?? null,
      frequency: input.frequency,
      daysOfWeek: input.daysOfWeek?.length ? input.daysOfWeek : Prisma.JsonNull,
      dayOfMonth: input.dayOfMonth ?? null,
      dueTime: input.dueTime ?? null,
      durationMinutes: input.durationMinutes ?? null,
      category: input.category ?? null,
      priority: input.priority ?? RoutinePriority.NORMAL,
      timeLocked: input.timeLocked ?? false,
      locationContext: input.locationContext ?? null,
      wellnessType: input.wellnessType ?? null,
    },
  });
  await generateRoutineOccurrences(userId, tz);
  return routine;
}

export async function updateRoutine(userId: string, tz: string, id: string, input: Partial<RoutineInput>): Promise<Routine | null> {
  const existing = await prisma.routine.findFirst({ where: { id, userId } });
  if (!existing) return null;
  const merged: RoutineInput = {
    title: input.title ?? existing.title,
    frequency: input.frequency ?? existing.frequency,
    daysOfWeek: input.daysOfWeek !== undefined ? input.daysOfWeek : (existing.daysOfWeek as number[] | null),
    dayOfMonth: input.dayOfMonth !== undefined ? input.dayOfMonth : existing.dayOfMonth,
    dueTime: input.dueTime !== undefined ? input.dueTime : existing.dueTime,
  };
  validate(merged);
  const routine = await prisma.routine.update({
    where: { id },
    data: {
      ...input,
      daysOfWeek: input.daysOfWeek === undefined ? undefined : input.daysOfWeek?.length ? input.daysOfWeek : Prisma.JsonNull,
    },
  });
  // Future pending occurrences follow the new schedule.
  const todayStart = startOfLocalDay(localYmd(new Date(), tz), tz);
  await prisma.routineOccurrence.deleteMany({
    where: { routineId: id, status: RoutineOccurrenceStatus.PENDING, occurrenceDate: { gte: todayStart } },
  });
  await generateRoutineOccurrences(userId, tz);
  return routine;
}

export async function deleteRoutine(userId: string, id: string): Promise<boolean> {
  const result = await prisma.routine.deleteMany({ where: { id, userId } });
  return result.count > 0;
}

/** Ensures occurrences exist for the next 14 local days — one batched insert. */
export async function generateRoutineOccurrences(userId: string, tz: string, days = GENERATE_DAYS): Promise<number> {
  const routines = await prisma.routine.findMany({ where: { userId, active: true } });
  if (!routines.length) return 0;
  const today = localYmd(new Date(), tz);
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
