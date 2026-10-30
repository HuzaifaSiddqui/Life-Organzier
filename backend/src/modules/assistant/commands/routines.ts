import { isWhatsapp } from "../channel.js";
import { RoutineFrequency, RoutineOccurrenceStatus, RoutinePriority, type Routine } from "@prisma/client";
import { sayAction } from "../actions.js";
import { z } from "zod";
import { prisma } from "../../../config/db.js";
import { HttpError } from "../../../lib/http.js";
import { relativeDayLabel } from "../../../lib/time.js";
import { formatDuration, fuzzySimilarity, listJoin } from "../../../lib/text.js";
import { deleteRoutine, listRoutines, occurrencesForDay, rescheduleOccurrence, updateOccurrence, updateRoutine } from "../../routines/routineService.js";
import { extractEntities, extractWeekdays } from "../entities.js";
import type { Out, Turn } from "../dialogue.js";
import { APP_LIST_CAP, WHATSAPP_LIST_CAP } from "../queryAnswers.js";
import { ASK, DO_IT, MOVE_WORDS, TODAY, ROUTINE, addBeforeMove, capture, has, norm, refFrom } from "./lexicon.js";
import { askChoice, recordUndo, runCommand, UNDO_ACTION } from "./runtime.js";
import { notifyRoutineFromWhatsapp } from "../../push/pushService.js";
import type { Command, CommandArgs, ParseCtx, Prepared } from "./types.js";

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const PAUSE = "pause|paused|hold|on hold|suspend|stop|disable|turn off|band|bund|rok|roko|rok do|روک|روکو|بند";
const RESUME = "resume|unpause|restart|turn on|turn back on|enable|start again|dobara shuru|dubara shuru|phir se shuru|wapas shuru|دوبارہ شروع|پھر سے شروع|بحال";
const DELETE = "delete|remove|get rid of|erase|discard|cancel|drop|hata do|hatao|hata|khatam|ختم|ہٹا|ہٹاؤ|ڈیلیٹ|مٹا";
const SKIP = "skip|skipping|miss|chhor|chor|chhod|chod|chhorna|nahi karunga|nahi karungi|nahi karna|چھوڑ|چھوڑو|نہیں کروں";
const DONE = "done|did|completed|finished|complete|ho gaya|ho gayi|ho gya|ho gyi|kar li|kar liya|kr li|mukammal|ہو گیا|ہو گئی|کر لی|کر لیا|مکمل";
const UPDATE = `change|move|set|make|update|shift|reschedule|rename|edit|switch|badal|badlo|بدل|بدلو|${DO_IT}`;
/** One occurrence only ("today's gym", "just this once", "sirf aaj"). */
const ONCE = "todays|today|just today|only today|this once|just this once|for today|this time|is baar|iss baar|sirf aaj|aaj ki|aaj ka|aaj ke|aaj wali|aaj wala|آج کی|آج کا|صرف آج|اس بار";
const MOVE = `${MOVE_WORDS}|${DO_IT}`;
const FIELD_WORDS = "time|timing|waqt|وقت|duration|days|day|priority|title|name|naam|minutes|minute|mins|hours|hour|only|instead|weekdays|weekends|mandatory|compulsory|important|normal|optional";
const WEEKDAY_WORDS =
  "sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|and|aur|or";

const refSchema = z.object({ ref: z.string().max(120).default(""), routineId: z.string().uuid().optional(), text: z.string().max(1000).optional() }).passthrough();

function lead(text: string): string {
  return text.split(/\s+(?:to|ko|into|as)\s+/i)[0];
}

/* ------------------------------------------------------------------ resolution */

type Found = { routine: Routine } | { out: Out };

/** "my gym routine" → the routine; several → asks which (numbered); none → says so. */
async function resolveRoutine(turn: Turn, command: string, args: CommandArgs): Promise<Found | { none: true; empty: boolean }> {
  const routines = await prisma.routine.findMany({ where: { userId: turn.user.id }, orderBy: { createdAt: "asc" } });
  if (typeof args.routineId === "string") {
    const r = routines.find((x) => x.id === args.routineId);
    if (r) return { routine: r };
  }
  if (!routines.length) return { none: true, empty: true };
  const ref = String(args.ref ?? "").trim().toLowerCase();
  if (!ref) {
    if (routines.length === 1) return { routine: routines[0] };
    return { out: askChoice(turn, command, args, "routineId", routines.map((r) => ({ id: r.id, label: r.title })), "Which routine?") };
  }
  const scored = routines
    .map((r) => ({ r, s: bare(r.title) === bare(ref) ? 1 : Math.max(fuzzySimilarity(ref, r.title), r.title.toLowerCase().includes(ref) ? 0.9 : 0) }))
    .filter((x) => x.s >= 0.34)
    .sort((a, b) => b.s - a.s);
  if (!scored.length) return { none: true, empty: false };
  const [first, second] = scored;
  if (first.s === 1 || (first.s >= 0.5 && (!second || first.s - second.s >= 0.12))) return { routine: first.r };
  return { out: askChoice(turn, command, args, "routineId", scored.map((x) => ({ id: x.r.id, label: x.r.title })), "Which routine do you mean?") };
}

/** "Go to gym" and the ref "go gym" are the same routine. */
const bare = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !["to", "the", "a", "an", "my", "of", "for"].includes(w)).join(" ");

function notFound(ref: string): Out {
  return { content: ref ? `I couldn't find a routine called "${ref}".` : "Which routine?", actions: [sayAction("Show my routines", "routine_list", "Show my routines")], intent: "routine_not_found" };
}

async function prepareRoutine(turn: Turn, command: string, args: CommandArgs, fallback?: string): Promise<Prepared> {
  const found = await resolveRoutine(turn, command, args);
  if ("none" in found) {
    // No routine by that name and the message never said "routine": it was about a task.
    if (fallback && args.text && !has(norm(String(args.text)), ROUTINE)) return { out: await runCommand(turn, fallback, { text: args.text }) };
    if (found.empty) return { out: { content: 'You don\'t have any routines yet. Try "Daily meditation at 6 AM for 10 minutes".', intent: "routine_none" } };
    return { out: notFound(String(args.ref ?? "")) };
  }
  if ("out" in found) return found;
  return { args: { ...args, routineId: found.routine.id } };
}

async function routineById(turn: Turn, args: CommandArgs): Promise<Routine | null> {
  return prisma.routine.findFirst({ where: { id: String(args.routineId), userId: turn.user.id } });
}

export function scheduleLabel(r: Pick<Routine, "frequency" | "daysOfWeek" | "dayOfMonth" | "dueTime"> & Partial<Pick<Routine, "intervalDays" | "anchorDate">>): string {
  const days = Array.isArray(r.daysOfWeek) ? (r.daysOfWeek as number[]) : [];
  const when = r.intervalDays
    ? `${r.intervalDays === 2 ? "every other day" : `every ${r.intervalDays} days`}${r.anchorDate ? ` from ${r.anchorDate}` : ""}`
    : r.frequency === RoutineFrequency.DAILY || days.length === 7
      ? "daily"
      : r.frequency === RoutineFrequency.MONTHLY
        ? `monthly on day ${r.dayOfMonth}`
        : days.join() === "1,2,3,4,5"
          ? "weekdays"
          : days.map((d) => DAY_SHORT[d]).join(", ");
  return `${when}${r.dueTime ? ` at ${r.dueTime}` : ", flexible time"}`;
}

async function todaysOccurrence(turn: Turn, routineId: string, ymd: string) {
  return (await occurrencesForDay(turn.user.id, turn.tz, ymd)).find((o) => o.routineId === routineId) ?? null;
}

/* ------------------------------------------------------------------ commands */

const routineList: Command = {
  name: "routine_list",
  category: "routines",
  summary: "List your routines",
  examples: ["Show my routines", "meri routines dikhao"],
  schema: z.object({}).passthrough(),
  undoable: false,
  parse(text) {
    const t = norm(text);
    if (!has(t, ROUTINE) || has(t, `${PAUSE}|${RESUME}|${DELETE}|${SKIP}|${UPDATE}|${DONE}`)) return null;
    return has(t, ASK) || /^(?:my |meri |all )?(?:routines?|روٹینز)$/.test(t) ? {} : null;
  },
  async execute(turn) {
    const routines = await listRoutines(turn.user.id, turn.tz, undefined, turn.now);
    if (!routines.length) return { content: 'You don\'t have any routines yet. Try "Daily meditation at 6 AM for 10 minutes".', intent: "routine_list" };
    const cap = isWhatsapp(turn.channel) ? WHATSAPP_LIST_CAP : APP_LIST_CAP;
    const lines = routines.slice(0, cap).map((r) => `• ${r.title}: ${scheduleLabel(r)}${r.active ? "" : " (paused)"}${r.priority === RoutinePriority.MANDATORY ? ", mandatory" : ""}`);
    if (routines.length > cap) lines.push(`…and ${routines.length - cap} more in the Routines screen.`);
    return { content: [`Your routines (${routines.length}):`, ...lines].join("\n"), actions: [{ label: "Open routines", payload: { type: "navigate", screen: "Routines" } }], intent: "routine_list" };
  },
};

const routineUpdate: Command = {
  name: "routine_update",
  category: "routines",
  summary: "Change a routine's time, days, title, priority or duration",
  examples: ["Change my gym routine to 7 PM", "Make my yoga routine Mon Wed Fri", "gym routine ka time 7 baje kar do"],
  schema: refSchema.extend({
    time: z.string().max(20).optional(),
    days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    title: z.string().max(120).optional(),
    priority: z.enum(["MANDATORY", "IMPORTANT", "NORMAL"]).optional(),
    durationMinutes: z.number().int().min(5).max(720).optional(),
  }),
  undoable: true,
  parse(text, ctx: ParseCtx) {
    const t = norm(text);
    // Only routines can be mandatory, so "Make Go to gym mandatory" (the button after a new routine) needs no "routine".
    const makeMandatory = /^(?:please )?(?:make|set|mark) .+ (?:as )?(?:mandatory|compulsory)$/.test(t);
    if ((!has(t, ROUTINE) && !makeMandatory) || !has(t, UPDATE) || has(t, `${ONCE}|${PAUSE}|${RESUME}|${DELETE}|${SKIP}`)) return null;
    const e = extractEntities(text, ctx.opts);
    const args: CommandArgs = {};
    if (e.time && e.timeExplicit) args.time = e.time;
    const days = extractWeekdays(text);
    if (days) args.days = days;
    const title = capture(text, /\b(?:rename|call)\b.*?\b(?:to|as)\s+(.+)$/i) ?? capture(text, /\bnaam\s+(.+?)\s+(?:rakh|kar)\s*(?:do|dein|den)?$/i);
    if (title) args.title = title.charAt(0).toUpperCase() + title.slice(1);
    if (has(t, "mandatory|compulsory|must do|lazmi|laazmi|لازمی")) args.priority = "MANDATORY";
    else if (has(t, "important|high priority|ahem|aham|اہم")) args.priority = "IMPORTANT";
    else if (has(t, "normal|optional|not mandatory|low priority")) args.priority = "NORMAL";
    if (e.durationMinutes) args.durationMinutes = e.durationMinutes;
    if (!Object.keys(args).length) return null;
    const source = title ? lead(text) : e.residual;
    return { ...args, ref: refFrom(source, `${ROUTINE}|${UPDATE}|${FIELD_WORDS}|${WEEKDAY_WORDS}|rename|call|duration`) };
  },
  prepare: (turn, args) => prepareRoutine(turn, "routine_update", args),
  async execute(turn, args) {
    const r = await routineById(turn, args);
    if (!r) return notFound(String(args.ref ?? ""));
    const changes: Parameters<typeof updateRoutine>[3] = {};
    const before: Record<string, unknown> = {};
    const said: string[] = [];
    if (typeof args.time === "string") {
      before.dueTime = r.dueTime;
      changes.dueTime = args.time;
      said.push(`at ${args.time}`);
    }
    if (Array.isArray(args.days)) {
      const days = args.days as number[];
      Object.assign(before, { frequency: r.frequency, daysOfWeek: r.daysOfWeek });
      changes.frequency = days.length === 7 ? RoutineFrequency.DAILY : RoutineFrequency.WEEKLY;
      changes.daysOfWeek = days.length === 7 ? null : days;
      said.push(days.length === 7 ? "every day" : days.join() === "1,2,3,4,5" ? "on weekdays" : `on ${listJoin(days.map((d) => DAY_SHORT[d]))}`);
    }
    if (typeof args.title === "string") {
      before.title = r.title;
      changes.title = args.title;
      said.push(`renamed to "${args.title}"`);
    }
    if (typeof args.priority === "string") {
      before.priority = r.priority;
      changes.priority = args.priority as RoutinePriority;
      said.push(args.priority === "MANDATORY" ? "mandatory" : args.priority === "IMPORTANT" ? "important" : "normal priority");
    }
    if (typeof args.durationMinutes === "number") {
      before.durationMinutes = r.durationMinutes;
      changes.durationMinutes = args.durationMinutes;
      said.push(`${formatDuration(args.durationMinutes)} long`);
    }
    try {
      const updated = await updateRoutine(turn.user.id, turn.tz, r.id, changes);
      if (!updated) return notFound(r.title);
      recordUndo(turn, { kind: "routine", routineId: r.id, before, label: `${r.title} change` });
      return { content: `Updated "${updated.title}": ${listJoin(said)}. Now ${scheduleLabel(updated)}.`, cards: [{ type: "routine", routine: updated as unknown as Record<string, unknown> }], actions: [UNDO_ACTION], intent: "routine_updated" };
    } catch (error) {
      if (error instanceof HttpError) return { content: error.message, intent: "routine_invalid" };
      throw error;
    }
  },
};

function activeToggle(name: "routine_pause" | "routine_resume", active: boolean): Command {
  return {
    name,
    category: "routines",
    summary: active ? "Resume a paused routine" : "Pause a routine (no reminders until resumed)",
    examples: active ? ["Resume my gym routine", "gym routine dobara shuru karo"] : ["Pause my gym routine", "gym routine band kar do"],
    schema: refSchema,
    undoable: true,
    parse(text) {
      const t = norm(text);
      if (has(t, DELETE) || has(t, SKIP)) return null;
      const verb = active ? has(t, RESUME) : has(t, PAUSE) && !has(t, RESUME);
      // "pause"/"resume" only ever mean routines; "stop", "band", "turn on" need the word "routine".
      if (!verb || !(has(t, ROUTINE) || has(t, active ? "resume|unpause" : "pause|paused"))) return null;
      return { ref: refFrom(text, `${ROUTINE}|${active ? RESUME : PAUSE}|for now|for a while|kuch din|${DO_IT}`) };
    },
    prepare: (turn, args) => prepareRoutine(turn, name, args),
    async execute(turn, args) {
      const r = await routineById(turn, args);
      if (!r) return notFound(String(args.ref ?? ""));
      if (r.active === active) return { content: `"${r.title}" is already ${active ? "active" : "paused"}.`, intent: name };
      await updateRoutine(turn.user.id, turn.tz, r.id, { active });
      recordUndo(turn, { kind: "routine", routineId: r.id, before: { active: r.active }, label: `${r.title} ${active ? "resumed" : "paused"}` });
      return {
        content: active ? `Resumed "${r.title}" (${scheduleLabel(r)}). Reminders are back on.` : `Paused "${r.title}". No reminders until you resume it.`,
        actions: [UNDO_ACTION],
        intent: active ? "routine_resumed" : "routine_paused",
      };
    },
  };
}

const routineDelete: Command = {
  name: "routine_delete",
  category: "routines",
  summary: "Delete a routine (asks first, undo for 24 hours)",
  examples: ["Delete my gym routine", "yoga routine delete kar do"],
  schema: refSchema,
  undoable: true,
  parse(text) {
    const t = norm(text);
    if (!has(t, ROUTINE) || !has(t, DELETE) || has(t, "what|which|how|why|kya|kia|kyun|کیا|کیوں")) return null;
    return { ref: refFrom(text, `${ROUTINE}|${DELETE}|${DO_IT}`) };
  },
  async prepare(turn, args) {
    const p = await prepareRoutine(turn, "routine_delete", args);
    if ("out" in p) return p;
    const r = await routineById(turn, p.args);
    return r ? { args: p.args, confirm: { question: `Delete the routine "${r.title}" (${scheduleLabel(r)})? Its past check-offs go too. You can undo for 24 hours.` } } : { out: notFound(String(args.ref)) };
  },
  async execute(turn, args) {
    const r = await routineById(turn, args);
    if (!r) return notFound(String(args.ref ?? ""));
    await deleteRoutine(turn.user.id, r.id);
    recordUndo(turn, { kind: "routine_deleted", snapshot: JSON.parse(JSON.stringify(r)) as Record<string, unknown>, label: `"${r.title}" deleted` });
    return { content: `Deleted the routine "${r.title}". You can undo this for 24 hours.`, actions: [UNDO_ACTION], intent: "routine_deleted" };
  },
};

/** Done / skipped today (FR-RM-003): today's occurrence of the routine. */
function todayStatus(name: "routine_skip_today" | "routine_complete_today", status: RoutineOccurrenceStatus): Command {
  const skip = status === RoutineOccurrenceStatus.SKIPPED;
  return {
    name,
    category: "routines",
    summary: skip ? "Skip a routine today (mandatory ones ask first)" : "Mark a routine done today",
    examples: skip ? ["Skip gym today", "aaj gym skip kar do"] : ["I did my gym routine today", "gym routine ho gayi"],
    schema: refSchema,
    undoable: true,
    parse(text) {
      const t = norm(text);
      if (skip) {
        if (!has(t, SKIP) || !(has(t, TODAY) || has(t, ROUTINE)) || has(t, `${DELETE}|${PAUSE}`)) return null;
      } else if (!has(t, ROUTINE) || !has(t, DONE) || has(t, `how|what|which|kya|kitni|kitne|کیا|کتنی`)) return null;
      const ref = refFrom(text, `${ROUTINE}|${skip ? SKIP : DONE}|${TODAY}|for today|mark|as|${DO_IT}`);
      return ref || has(t, ROUTINE) ? { ref, text } : null;
    },
    async prepare(turn, args) {
      const p = await prepareRoutine(turn, name, args, skip ? undefined : "complete_task");
      if ("out" in p) return p;
      const r = await routineById(turn, p.args);
      const o = r ? await todaysOccurrence(turn, r.id, turn.todayYmd) : null;
      if (!r || !o) return { out: { content: `"${r?.title ?? args.ref}" isn't scheduled today.`, intent: "routine_not_today" } };
      if (o.status === status) return { out: { content: `"${r.title}" is already ${skip ? "skipped" : "done"} for today.`, intent: name } };
      const next = { ...p.args, occurrenceId: o.id };
      if (skip && r.priority === RoutinePriority.MANDATORY) return { args: next, confirm: { question: `"${r.title}" is mandatory. Skip it today anyway?` } };
      return { args: next };
    },
    async execute(turn, args) {
      const occurrenceId = String(args.occurrenceId);
      const before = await prisma.routineOccurrence.findFirst({ where: { id: occurrenceId, userId: turn.user.id } });
      if (!before) return { content: "That routine isn't scheduled any more.", intent: "not_found" };
      const o = await updateOccurrence(turn.user.id, occurrenceId, status, { confirmMandatory: true });
      if (!o) return { content: "That routine isn't scheduled any more.", intent: "not_found" };
      recordUndo(turn, { kind: "occurrence", occurrenceId, before: { status: before.status, occurrenceDate: before.occurrenceDate.toISOString(), dueTime: before.dueTime }, label: `${o.routine.title} ${skip ? "skipped" : "done"} today` });
      if (isWhatsapp(turn.channel)) notifyRoutineFromWhatsapp(turn.user.id, o.routine.title, skip ? "skipped" : "done");
      return { content: skip ? `Skipped "${o.routine.title}" for today.` : `"${o.routine.title}" done for today. Keep the streak going!`, actions: [UNDO_ACTION], intent: skip ? "routine_skipped" : "routine_done" };
    },
  };
}

const routineRescheduleOnce: Command = {
  name: "routine_reschedule_once",
  category: "routines",
  summary: "Move one occurrence of a routine (the routine itself stays as it is)",
  examples: ["Move today's gym to 8 PM", "Move my reading routine to tomorrow just this once"],
  schema: refSchema.extend({ fromYmd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), ymd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), time: z.string().max(20).optional() }),
  undoable: true,
  parse(text, ctx) {
    const t = norm(text);
    if (!has(t, MOVE) || !has(t, ONCE) || addBeforeMove(t) || has(t, `${DELETE}|${SKIP}|${PAUSE}`) || has(t, "all|everything|saare|sare|sab|tamam|تمام|سارے|سب")) return null;
    // The source day ("today's") is not the target: dates come from what is left after removing it.
    const rest = text.replace(/\b(?:today'?s|todays|aaj\s+(?:ki|ka|ke|wali|wala))\b|آج\s+(?:کی|کا|کے)/gi, " ");
    const e = extractEntities(rest, ctx.opts);
    if (!e.date && !(e.time && e.timeExplicit)) return null;
    const args: CommandArgs = { fromYmd: ctx.todayYmd, ymd: e.date?.ymd ?? ctx.todayYmd, text };
    if (e.time && e.timeExplicit) args.time = e.time;
    args.ref = refFrom(e.residual, `${ROUTINE}|${MOVE}|${ONCE}|just|this once|once|${TODAY}|tomorrow|tomorrows|kal`);
    return args;
  },
  async prepare(turn, args) {
    const p = await prepareRoutine(turn, "routine_reschedule_once", args, "update_task");
    if ("out" in p) return p;
    const r = await routineById(turn, p.args);
    const o = r ? await todaysOccurrence(turn, r.id, String(args.fromYmd ?? turn.todayYmd)) : null;
    if (!r || !o) return { out: { content: `"${r?.title ?? args.ref}" isn't scheduled ${relativeDayLabel(String(args.fromYmd ?? turn.todayYmd), turn.todayYmd)}.`, intent: "routine_not_today" } };
    return { args: { ...p.args, occurrenceId: o.id } };
  },
  async execute(turn, args) {
    const occurrenceId = String(args.occurrenceId);
    const before = await prisma.routineOccurrence.findFirst({ where: { id: occurrenceId, userId: turn.user.id } });
    if (!before) return { content: "That routine isn't scheduled any more.", intent: "not_found" };
    try {
      const ymd = String(args.ymd ?? args.fromYmd ?? turn.todayYmd);
      const o = await rescheduleOccurrence(turn.user.id, turn.tz, occurrenceId, ymd, typeof args.time === "string" ? args.time : null);
      if (!o) return { content: "That routine isn't scheduled any more.", intent: "not_found" };
      recordUndo(turn, { kind: "occurrence", occurrenceId: o.id, before: { status: before.status, occurrenceDate: before.occurrenceDate.toISOString(), dueTime: before.dueTime }, label: `${o.routine.title} moved` });
      return { content: `Moved "${o.routine.title}" to ${relativeDayLabel(ymd, turn.todayYmd)}${o.dueTime ? ` at ${o.dueTime}` : ""}, just this once. The routine itself is unchanged.`, actions: [UNDO_ACTION], intent: "routine_rescheduled" };
    } catch (error) {
      if (error instanceof HttpError) return { content: error.message, intent: "routine_time_locked" };
      throw error;
    }
  },
};

/** Match order: specific verbs first; list (questions) last. */
export const routineCommands: Command[] = [
  routineDelete,
  activeToggle("routine_resume", true),
  activeToggle("routine_pause", false),
  todayStatus("routine_skip_today", RoutineOccurrenceStatus.SKIPPED),
  routineRescheduleOnce,
  todayStatus("routine_complete_today", RoutineOccurrenceStatus.COMPLETED),
  routineUpdate,
  routineList,
];

