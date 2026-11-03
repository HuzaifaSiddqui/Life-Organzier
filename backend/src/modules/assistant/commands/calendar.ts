import { z } from "zod";
import { calendarSyncOn } from "../../calendar/calendarService.js";
import { getTaskForUser } from "../../tasks/taskService.js";
import { focusOn, type Out, type Turn } from "../dialogue.js";
import { resolveTaskRef } from "../draft.js";
import { extractEntities } from "../entities.js";
import { askChoice, runCommand } from "./runtime.js";
import { norm, refFrom, TASK_WORD } from "./lexicon.js";
import type { Command, CommandArgs, ParseCtx, Prepared } from "./types.js";

/**
 * CALENDAR_SYNC (off): chat about the phone's calendar. The phone's calendar never reaches the server, so these
 * replies carry a `calendar` card that the app fills in on the phone (agenda, free time, "added"). The server
 * only picks the day (entities.ts) and the task. WhatsApp can't see the phone, so it gets a pointer to the app.
 */

const CAL = "(?:phone |google |outlook )?(?:calendar|calender|calander)";
const dayArgs = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).passthrough();
const onPhoneOnly = (turn: Turn) => turn.channel === "WHATSAPP" || turn.channel === "WHATSAPP_AGENT";
const PHONE_ONLY: Out = { content: "Your calendar lives on your phone, so ask me this in the Life Organizer app.", intent: "calendar_phone_only" };

const dayOf = (text: string, ctx: ParseCtx) => extractEntities(text, ctx.opts).date?.ymd ?? ctx.todayYmd;

function dayLabel(turn: Turn, ymd: string): string {
  if (ymd === turn.todayYmd) return "today";
  const d = new Date(`${ymd}T12:00:00Z`);
  const diff = Math.round((d.getTime() - new Date(`${turn.todayYmd}T12:00:00Z`).getTime()) / 86400000);
  if (diff === 1) return "tomorrow";
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
}

/** "add this to my calendar", "put the essay in my calendar", "sync it with my calendar". */
export function parseCalendarAdd(text: string): CommandArgs | null {
  const t = norm(text);
  const m = new RegExp(`^(?:please |can you |could you )?(?:add|put|save|sync|send)\\s+(.*?)\\s*(?:to|in|into|on|onto|with)\\s+(?:my |the )?${CAL}(?: too| as well| please)?$`).exec(t);
  if (!m) return null;
  // The message without "to my calendar", in the user's words: a new task when nothing matches.
  const rest = text.replace(/\s*\b(?:to|in|into|on|onto|with)\s+(?:my |the )?(?:phone |google |outlook )?(?:calendar|calender|calander)\b.*$/i, "").trim();
  return { ref: refFrom(m[1], TASK_WORD), text: rest };
}

/** "what's on my calendar tomorrow", "show my calendar for friday", "my calendar today". */
export function parseCalendarAgenda(text: string, ctx: ParseCtx): CommandArgs | null {
  const t = norm(text);
  const asks =
    new RegExp(`^(?:what|whats|what is|what do i have|what have i got|anything|is there anything|do i have anything|show|show me|open|check|read|list)\\b.*\\b(?:on|in) (?:my |the )?${CAL}\\b`).test(t) ||
    new RegExp(`^(?:show |check |read )?(?:me )?(?:my )?${CAL}(?: for)?(?: today| tomorrow| this \\w+| on \\w+| \\w+day)?$`).test(t);
  return asks ? { date: dayOf(text, ctx) } : null;
}

/** "when am I free tomorrow", "am I free on friday", "free slots today", "find me free time tomorrow". */
export function parseCalendarFree(text: string, ctx: ParseCtx): CommandArgs | null {
  const t = norm(text);
  const asks =
    /^(?:so )?(?:when|what time|at what time) (?:am|m) i free\b/.test(t) ||
    /^am i free\b/.test(t) ||
    /^(?:show|find|list|give)(?: me)? (?:my )?free (?:time|slots?|hours)\b/.test(t) ||
    /^(?:my )?free (?:time|slots?)(?: today| tomorrow| on \w+| this \w+| \w+day)?$/.test(t);
  return asks ? { date: dayOf(text, ctx) } : null;
}

const calendarAdd: Command = {
  name: "calendar_add",
  category: "tasks",
  summary: "Put a task in your phone's calendar",
  enabled: calendarSyncOn,
  examples: ["Add this to my calendar", "Put the essay in my calendar"],
  schema: z.object({ ref: z.string().max(120).default(""), taskId: z.string().uuid().optional(), text: z.string().max(1000).optional() }).passthrough(),
  undoable: false,
  parse: (text) => parseCalendarAdd(text),
  async prepare(turn, args): Promise<Prepared> {
    if (onPhoneOnly(turn)) return { out: PHONE_ONLY };
    if (typeof args.taskId === "string" && (await getTaskForUser(turn.user.id, args.taskId))) return { args };
    const ref = String(args.ref ?? "");
    const r = await resolveTaskRef(turn.user.id, ref, turn.state.focus, { listed: turn.state.listed });
    if (r.task) return { args: { ...args, taskId: r.task.id } };
    if (r.candidates.length && ref) return { out: askChoice(turn, "calendar_add", args, "taskId", r.candidates.map((t) => ({ id: t.id, label: t.title })), "Which task do you mean?") };
    // "add dentist appointment on Friday to my calendar" with no such task: it's a new task (which then syncs).
    if (ref) return { out: await runCommand(turn, "create_task", { text: String(args.text || ref) }) };
    return { out: { content: "Which task should go in your calendar?", intent: "not_found" } };
  },
  async execute(turn, args) {
    const task = await getTaskForUser(turn.user.id, String(args.taskId));
    if (!task) return { content: "I couldn't find that task anymore.", intent: "not_found" };
    focusOn(turn, task.id);
    if (!task.dueDate && !task.scheduledStart) {
      return { content: `"${task.title}" has no date yet. Give it one and it goes in your calendar.`, actions: [{ label: "Set a date", payload: { type: "open_task", taskId: task.id } }], intent: "calendar_add" };
    }
    return { content: `"${task.title}" in your phone calendar:`, cards: [{ type: "calendar", kind: "add", date: turn.todayYmd, taskId: task.id, title: task.title }], intent: "calendar_add" };
  },
};

const calendarAgenda: Command = {
  name: "calendar_agenda",
  category: "general",
  summary: "What's on your phone's calendar on a day",
  enabled: calendarSyncOn,
  examples: ["What's on my calendar tomorrow?", "Show my calendar for Friday"],
  schema: dayArgs,
  undoable: false,
  parse: parseCalendarAgenda,
  async execute(turn, args) {
    if (onPhoneOnly(turn)) return PHONE_ONLY;
    const date = String(args.date);
    return { content: `Your calendar ${dayLabel(turn, date)}:`, cards: [{ type: "calendar", kind: "agenda", date }], intent: "calendar_agenda" };
  },
};

const calendarFree: Command = {
  name: "calendar_free",
  category: "general",
  summary: "When you're free on a day (from your phone's calendar and your plan)",
  enabled: calendarSyncOn,
  examples: ["When am I free tomorrow?", "Am I free on Friday?"],
  schema: dayArgs,
  undoable: false,
  parse: parseCalendarFree,
  async execute(turn, args) {
    if (onPhoneOnly(turn)) return PHONE_ONLY;
    const date = String(args.date);
    return { content: `Free time ${dayLabel(turn, date)}:`, cards: [{ type: "calendar", kind: "free", date }], intent: "calendar_free" };
  },
};

export const calendarCommands: Command[] = [calendarAdd, calendarAgenda, calendarFree];
