import { ReminderMode, RoutinePriority, TaskStatus, type Task, type UserSettings } from "@prisma/client";
import { prisma } from "../../config/db.js";
import {
  addDaysYmd,
  diffDaysYmd,
  formatClock,
  inWindow,
  instantLabel,
  localParts,
  localYmd,
  minutesOfDay,
  parseClock,
  zonedTimeToUtc,
} from "../../lib/time.js";
import { formatDuration, plural } from "../../lib/text.js";
import { getPatterns, peakWindowsFrom } from "../patterns/patternService.js";
import { occurrenceStart, occurrencesBetween } from "../routines/routineService.js";

export type ReminderLevel = "gentle" | "normal" | "urgent" | "critical";

export type PlannedReminder = {
  id: string;
  taskId: string | null;
  routineOccurrenceId: string | null;
  fireAt: string;
  level: ReminderLevel;
  title: string;
  body: string;
  prominent: boolean;
};

/** `onTime`: the reminder at the time the user set — it fires even in quiet hours, like an alarm. */
export type Draft = { at: Date; level: ReminderLevel; body: string; onTime?: boolean };

const MAX_REMINDERS = 60;
/**
 * Routine reminders may use at most this many of the 60 slots when tasks need the rest (and tasks at most the
 * rest when routines need these): 3-4 reminders per occurrence would otherwise push task reminders out.
 */
export const ROUTINE_REMINDER_SHARE = 24;
/** Follow-ups ("Still to do") only for occurrences this soon; later days keep the start nudge and the alarm. */
const FOLLOW_UP_HORIZON_MS = 36 * 3600000;

function quietMinutes(settings: UserSettings) {
  return {
    start: minutesOfDay(parseClock(settings.quietStart) ?? { h: 22, m: 0 }),
    end: minutesOfDay(parseClock(settings.quietEnd) ?? { h: 8, m: 0 }),
  };
}

/** Moves a reminder out of quiet hours (FR-RN-001 §6): to quiet-end, or to the evening before if that would be too late. */
export function respectQuietHours(at: Date, deadline: Date | null, settings: UserSettings, tz: string): Date {
  const q = quietMinutes(settings);
  const p = localParts(at, tz);
  const m = p.h * 60 + p.mi;
  if (!inWindow(m, q.start, q.end)) return at;
  const ymd = localYmd(at, tz);
  const morningYmd = q.start > q.end && m >= q.start ? addDaysYmd(ymd, 1) : ymd;
  const morning = zonedTimeToUtc(morningYmd, Math.floor(q.end / 60), q.end % 60, tz);
  if (!deadline || morning < deadline) return morning;
  const eveningYmd = q.start > q.end && m < q.end ? addDaysYmd(ymd, -1) : ymd;
  const eveningMin = Math.max(0, q.start - 60);
  const evening = zonedTimeToUtc(eveningYmd, Math.floor(eveningMin / 60), eveningMin % 60, tz);
  return evening < deadline ? evening : at;
}

function atLocal(ymd: string, hour: number, minute: number, tz: string): Date {
  return zonedTimeToUtc(ymd, hour, minute, tz);
}

export type Adaptivity = { ignoreRate: number; samples: number; earlyCompleter: boolean };

async function adaptivityFor(userId: string): Promise<Map<string, Adaptivity>> {
  const logs = await prisma.reminderLog.findMany({
    where: { userId, status: { in: ["ACTED", "IGNORED"] }, fireAt: { gte: new Date(Date.now() - 60 * 86400000) } },
    select: { category: true, status: true, action: true },
  });
  return adaptivityFromLogs(logs);
}

/** Per-category (and "*" overall) ignore rate and early-completion habit from reminder history. */
export function adaptivityFromLogs(logs: Array<{ category: string | null; status: string; action: string | null }>): Map<string, Adaptivity> {
  const map = new Map<string, { ignored: number; total: number; doneFirst: number }>();
  for (const l of logs) {
    for (const key of [l.category ?? "Uncategorized", "*"]) {
      const e = map.get(key) ?? { ignored: 0, total: 0, doneFirst: 0 };
      e.total += 1;
      if (l.status === "IGNORED") e.ignored += 1;
      if (l.action === "DONE") e.doneFirst += 1;
      map.set(key, e);
    }
  }
  const out = new Map<string, Adaptivity>();
  for (const [k, v] of map) out.set(k, { ignoreRate: v.ignored / v.total, samples: v.total, earlyCompleter: v.doneFirst / v.total >= 0.6 });
  return out;
}

/** Builds the reminder sequence for one task according to its (or the global) reminder mode. */
export function sequenceForTask(
  task: Task,
  settings: UserSettings,
  tz: string,
  peakStartHour: number,
  adapt: Adaptivity | undefined,
  now: Date,
): Draft[] {
  if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.DELETED || task.status === TaskStatus.SKIPPED) return [];
  const startDraft: Draft[] =
    task.scheduledStart && task.scheduledStart > now && settings.notificationFrequency !== "NONE" && task.reminderMode !== ReminderMode.NONE
      ? [{ at: new Date(task.scheduledStart.getTime() - 10 * 60000), level: "normal", body: `Starts in 10 minutes${task.scheduledEnd ? ` (until ${instantLabel(task.scheduledEnd, tz, now).split(" ").slice(1).join(" ")})` : ""}` }]
      : [];
  if (!task.dueAt || task.dueAt <= now) return startDraft;
  // Scheduled work with a date-only deadline: the start reminder is enough (no noisy escalation).
  if (startDraft.length && !task.dueTime) return startDraft;
  const sequence = deadlineSequence(task, settings, tz, peakStartHour, adapt, now);
  // Earlier nudges alone left short-notice tasks ("remind me in 20 min") with nothing at all.
  const onTime: Draft[] =
    task.dueTime && sequence.length ? [{ at: task.dueAt, level: "critical", body: task.taskType === "FIXED" ? "Starting now" : "Due now", onTime: true }] : [];
  return [...startDraft, ...sequence, ...onTime];
}

function deadlineSequence(task: Task, settings: UserSettings, tz: string, peakStartHour: number, adapt: Adaptivity | undefined, now: Date): Draft[] {
  if (!task.dueAt) return [];
  const global = settings.notificationFrequency;
  let mode: ReminderMode = task.reminderMode;
  if (mode === ReminderMode.ADAPTIVE) {
    if (global === "NONE") return [];
    mode = global === "MINIMAL" ? ReminderMode.SINGLE : global === "FREQUENT" ? ReminderMode.ESCALATING : ReminderMode.ADAPTIVE;
  }
  if (mode === ReminderMode.NONE) return [];

  const due = task.dueAt;
  const dueLabel = instantLabel(due, tz, now);
  const duration = task.durationMinutes ?? 60;
  const dueYmd = localYmd(due, tz);
  const todayYmd = localYmd(now, tz);
  const daysLeft = diffDaysYmd(todayYmd, dueYmd);
  const drafts: Draft[] = [];

  if (task.reminderMinutes !== null && task.reminderMinutes !== undefined) {
    drafts.push({ at: new Date(due.getTime() - task.reminderMinutes * 60000), level: "urgent", body: `Due ${dueLabel}` });
    if (mode === ReminderMode.SINGLE) return drafts;
  }

  // Critical reminder: early enough to still do the work, inside productive hours when possible.
  const latestStart = new Date(due.getTime() - (duration + 120) * 60000);
  const peakOnDueDay = atLocal(dueYmd, peakStartHour, 0, tz);
  let critical = peakOnDueDay <= latestStart ? peakOnDueDay : latestStart;
  if (critical <= now) critical = latestStart;
  const hoursLeftAtCritical = Math.max(1, Math.round((due.getTime() - critical.getTime()) / 3600000));
  const criticalBody = `Final reminder: ${plural(hoursLeftAtCritical, "hour")} left — needs about ${formatDuration(duration)}. Due ${dueLabel}.`;

  if (mode === ReminderMode.SINGLE) {
    drafts.push({ at: critical, level: "critical", body: criticalBody });
    return drafts;
  }

  if (mode === ReminderMode.MULTIPLE) {
    if (daysLeft >= 1) drafts.push({ at: atLocal(addDaysYmd(dueYmd, -1), 10, 0, tz), level: "normal", body: `Due tomorrow (${dueLabel})` });
    drafts.push({ at: critical, level: "critical", body: criticalBody });
    drafts.push({ at: new Date(due.getTime() - 60 * 60000), level: "urgent", body: "1 hour left!" });
    return drafts;
  }

  // ESCALATING / ADAPTIVE: gentle → urgent sequence (FR-RN-001 §4).
  if (daysLeft >= 3) drafts.push({ at: atLocal(addDaysYmd(dueYmd, -3), 14, 0, tz), level: "gentle", body: `3 days until "${task.title}" is due (${dueLabel})` });
  if (daysLeft >= 2) {
    drafts.push({ at: atLocal(addDaysYmd(dueYmd, -2), peakStartHour, 0, tz), level: "normal", body: `2 days left. This is a good time to start — it needs about ${formatDuration(duration)}.` });
  }
  if (daysLeft >= 1) drafts.push({ at: atLocal(addDaysYmd(dueYmd, -1), 10, 0, tz), level: "urgent", body: `Due tomorrow! (${dueLabel})` });
  drafts.push({ at: critical, level: "critical", body: criticalBody });
  drafts.push({ at: new Date(due.getTime() - 60 * 60000), level: "urgent", body: "1 hour left!" });

  if (mode === ReminderMode.ADAPTIVE && adapt && adapt.samples >= 3) {
    if (adapt.ignoreRate >= 0.5 && daysLeft >= 4) {
      // Reminders for this kind of task tend to be ignored: start earlier and make them prominent.
      drafts.unshift({ at: atLocal(addDaysYmd(dueYmd, -4), peakStartHour, 0, tz), level: "normal", body: `Heads up: "${task.title}" is due ${dueLabel}. Plan when you'll do it?` });
    } else if (adapt.earlyCompleter && adapt.ignoreRate < 0.2) {
      // The user usually acts on the first reminder: keep it lighter.
      return drafts.filter((d) => d.level !== "gentle" && !(d.level === "urgent" && d.body.startsWith("Due tomorrow")));
    }
  }
  return drafts;
}

/**
 * Final fire time for one task reminder: quiet hours (except the on-time reminder), Do Not Disturb
 * (critical reminders may override it), and the planning window. Null when it shouldn't fire.
 */
export function placeTaskReminder(
  draft: Draft,
  dueAt: Date | null,
  settings: UserSettings,
  tz: string,
  dndUntil: Date | null,
  now: Date,
  horizon: Date,
): Date | null {
  let at = draft.onTime ? draft.at : respectQuietHours(draft.at, dueAt, settings, tz);
  if (dndUntil && at < dndUntil && !(draft.level === "critical" && settings.criticalOverridesDnd)) at = dndUntil;
  if (at <= now || at > horizon || (dueAt && (draft.onTime ? at > dueAt : at >= dueAt))) return null;
  return at;
}

/**
 * Whether a planned reminder may still go out at `at`, by the same rules as placeTaskReminder. Do Not
 * Disturb or quiet hours may have changed since the plan was made (WhatsApp checks this before sending).
 */
export function stillAllowedAt(at: Date, level: ReminderLevel, onTime: boolean, dueAt: Date | null, settings: UserSettings, tz: string): boolean {
  const placed = placeTaskReminder({ at, level, body: "", onTime }, dueAt, settings, tz, settings.dndUntil, new Date(at.getTime() - 1), new Date(at.getTime() + 1));
  return placed?.getTime() === at.getTime();
}

export type RoutineReminderKind = "start" | "time" | "follow1" | "follow2";
type RoutineSettings = Pick<UserSettings, "quietStart" | "quietEnd" | "criticalOverridesDnd" | "notificationFrequency">;

/**
 * One pending routine occurrence → its reminders (phase 1):
 * - start: 10 minutes before; skipped in quiet hours and Do Not Disturb (mandatory + criticalOverridesDnd: DND only);
 * - time: the "it's time" alarm at the set time; fires even in quiet hours, like a task's on-time alarm (DND: only
 *   when criticalOverridesDnd);
 * - follow1: 20 minutes after ("Still to do"), follow2: 60 minutes after (mandatory only); only for occurrences in
 *   the next 36 hours; quiet hours and DND skip them, except mandatory routines when criticalOverridesDnd is on.
 * Minimal reminders: a normal routine gets only the alarm. "Still pending" is kept by re-planning: a done or
 * skipped occurrence is not planned, and the phone drops its scheduled ones.
 */
export function routineReminderTimes(
  start: Date,
  priority: RoutinePriority,
  settings: RoutineSettings,
  tz: string,
  dndUntil: Date | null,
  now: Date,
): Array<{ kind: RoutineReminderKind; at: Date }> {
  const q = quietMinutes(settings as UserSettings);
  const quiet = (at: Date) => {
    const p = localParts(at, tz);
    return inWindow(p.h * 60 + p.mi, q.start, q.end);
  };
  const inDnd = (at: Date) => Boolean(dndUntil && at < dndUntil);
  const mandatory = priority === RoutinePriority.MANDATORY;
  const override = mandatory && settings.criticalOverridesDnd;
  const minimal = settings.notificationFrequency === "MINIMAL" && priority === RoutinePriority.NORMAL;
  const out: Array<{ kind: RoutineReminderKind; at: Date }> = [];
  const add = (kind: RoutineReminderKind, at: Date) => {
    if (at > now) out.push({ kind, at: new Date(Math.floor(at.getTime() / 60000) * 60000) });
  };
  const nudge = new Date(start.getTime() - 10 * 60000);
  if (!minimal && !quiet(nudge) && (!inDnd(nudge) || override)) add("start", nudge);
  if (!inDnd(start) || settings.criticalOverridesDnd) add("time", start);
  if (minimal || start.getTime() - now.getTime() > FOLLOW_UP_HORIZON_MS) return out;
  for (const [kind, minutes] of [["follow1", 20], ...(mandatory ? [["follow2", 60]] : [])] as Array<[RoutineReminderKind, number]>) {
    const at = new Date(start.getTime() + minutes * 60000);
    if (override || (!quiet(at) && !inDnd(at))) add(kind, at);
  }
  return out;
}

/** Soonest first; when both overflow, routines keep ROUTINE_REMINDER_SHARE slots and tasks the rest. */
export function capReminders(tasks: PlannedReminder[], routines: PlannedReminder[], max = MAX_REMINDERS): PlannedReminder[] {
  const byTime = (a: PlannedReminder, b: PlannedReminder) => a.fireAt.localeCompare(b.fireAt);
  const r = [...routines].sort(byTime);
  const t = [...tasks].sort(byTime);
  const routineRoom = Math.max(ROUTINE_REMINDER_SHARE, max - t.length);
  const keptRoutines = r.slice(0, routineRoom);
  return [...t.slice(0, max - keptRoutines.length), ...keptRoutines].sort(byTime);
}

export async function planReminders(userId: string, settings: UserSettings, now = new Date(), horizonDays = 7): Promise<PlannedReminder[]> {
  const tz = settings.timezone;
  if (settings.notificationFrequency === "NONE") return [];
  const horizon = new Date(now.getTime() + horizonDays * 86400000);
  const [tasks, patterns, adaptivity, occurrences] = await Promise.all([
    prisma.task.findMany({
      where: {
        userId,
        status: { in: [TaskStatus.PENDING, TaskStatus.IN_PROGRESS] },
        archived: false,
        dueAt: { gt: now, lte: new Date(horizon.getTime() + 5 * 86400000) },
      },
    }),
    getPatterns(userId, tz),
    adaptivityFor(userId),
    occurrencesBetween(userId, now, horizon, settings.currentContext),
  ]);
  const peak = peakWindowsFrom(patterns);
  const peakStartHour = peak.windows[0]?.start ?? 9;
  const dndUntil = settings.dndUntil && settings.dndUntil > now ? settings.dndUntil : null;
  const out: PlannedReminder[] = [];
  const routineOut: PlannedReminder[] = [];

  for (const task of tasks) {
    const adapt = adaptivity.get(task.category ?? "Uncategorized") ?? adaptivity.get("*");
    const prominent = Boolean(adapt && adapt.samples >= 3 && adapt.ignoreRate >= 0.5);
    const seen = new Set<number>();
    for (const draft of sequenceForTask(task, settings, tz, peakStartHour, adapt, now)) {
      const at = placeTaskReminder(draft, task.dueAt, settings, tz, dndUntil, now, horizon);
      if (!at) continue;
      const minuteKey = Math.floor(at.getTime() / 60000);
      if (seen.has(minuteKey)) continue;
      seen.add(minuteKey);
      out.push({
        id: `t:${task.id}:${minuteKey}`,
        taskId: task.id,
        routineOccurrenceId: null,
        fireAt: at.toISOString(),
        level: draft.level,
        title: draft.level === "critical" || prominent ? `${task.title}` : task.title,
        body: draft.body,
        prominent: prominent || draft.level === "critical",
      });
    }
  }

  for (const o of occurrences) {
    if (o.status !== "PENDING" || !parseClock(o.dueTime)) continue;
    const start = occurrenceStart(o, tz);
    const p = localParts(start, tz);
    const clock = formatClock(p.h, p.mi);
    const mandatory = o.routine.priority === RoutinePriority.MANDATORY;
    for (const { kind, at } of routineReminderTimes(start, o.routine.priority, settings, tz, dndUntil, now)) {
      if (at > horizon) continue;
      routineOut.push({
        id: `r:${o.id}:${kind}`,
        taskId: null,
        routineOccurrenceId: o.id,
        fireAt: at.toISOString(),
        level: kind === "time" ? "critical" : kind === "start" ? "normal" : mandatory ? "critical" : "urgent",
        title: kind === "follow1" || kind === "follow2" ? `Still to do: ${o.routine.title}` : o.routine.title,
        body:
          kind === "start"
            ? `Starts in 10 minutes (${clock})${o.routine.durationMinutes ? ` · ${formatDuration(o.routine.durationMinutes)}` : ""}`
            : kind === "time"
              ? `It's time (${clock})`
              : `Routine at ${clock}${mandatory ? " · mandatory" : ""}`,
        prominent: kind === "time" || mandatory,
      });
    }
  }

  const planned = capReminders(out, routineOut);
  await recordPlan(userId, planned, tasks, now);
  return planned;
}

/** Routine occurrences from yesterday to tomorrow that are still pending (for snoozes on the phone). */
export async function pendingRoutineOccurrenceIds(userId: string, now: Date): Promise<string[]> {
  const rows = await prisma.routineOccurrence.findMany({
    where: { userId, status: "PENDING", occurrenceDate: { gte: new Date(now.getTime() - 2 * 86400000), lt: new Date(now.getTime() + 2 * 86400000) } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Persists the plan so ignored reminders can be detected and used for adaptation. */
async function recordPlan(userId: string, planned: PlannedReminder[], tasks: Task[], now: Date): Promise<void> {
  const categoryOf = new Map(tasks.map((t) => [t.id, t.category]));
  // Reminders that already fired without any interaction count as ignored.
  await prisma.reminderLog.updateMany({
    where: { userId, status: "SCHEDULED", fireAt: { lt: new Date(now.getTime() - 30 * 60000) } },
    data: { status: "IGNORED" },
  });
  await prisma.reminderLog.deleteMany({ where: { userId, status: "SCHEDULED", fireAt: { gte: now } } });
  const rows = planned
    .filter((p) => p.taskId)
    .map((p) => ({
      userId,
      taskId: p.taskId,
      fireAt: new Date(p.fireAt),
      level: p.level,
      category: categoryOf.get(p.taskId as string) ?? null,
    }));
  if (rows.length) await prisma.reminderLog.createMany({ data: rows, skipDuplicates: true });
  await prisma.userSettings.updateMany({ where: { userId }, data: { remindersPlannedAt: now } });
}

/** Notification action from the device: DONE | SNOOZE | OPEN | DISMISS. */
export async function recordReminderAction(userId: string, taskId: string, fireAt: Date | null, action: string): Promise<void> {
  const where = fireAt
    ? { userId, taskId, fireAt }
    : { userId, taskId, fireAt: { lte: new Date(Date.now() + 60000) }, status: { in: ["SCHEDULED", "IGNORED"] } };
  const log = await prisma.reminderLog.findFirst({ where, orderBy: { fireAt: "desc" } });
  if (log) {
    await prisma.reminderLog.update({ where: { id: log.id }, data: { status: action === "DISMISS" ? "IGNORED" : "ACTED", action, actedAt: new Date() } });
  }
}
