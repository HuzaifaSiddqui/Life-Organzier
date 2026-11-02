import { isWhatsapp } from "../channel.js";
import { chatFixesOn, MORE_DELETE } from "../chatFixes.js";
import { Priority, TaskStatus, TaskType, type Task } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../../config/db.js";
import { addDaysYmd, diffDaysYmd, dueDateFromYmd, localYmd, relativeDayLabel, startOfLocalDay } from "../../../lib/time.js";
import { plural } from "../../../lib/text.js";
import { logEvent } from "../../events/eventService.js";
import { getTaskForUser, listActiveTasks, serializeTask, softDeleteTask, updateTask } from "../../tasks/taskService.js";
import type { Turn } from "../dialogue.js";
import { extractTargetDay } from "../entities.js";
import { WHATSAPP_LIST_CAP } from "../queryAnswers.js";
import { ALL, DO_IT, MOVE_WORDS, TASK_WORD, TODAY, addBeforeMove, has, norm } from "./lexicon.js";
import { commandText, dayLabelFor } from "./copy.js";
import { recordUndo, snapshots, undoAction } from "./runtime.js";
import type { Command, CommandArgs, Prepared } from "./types.js";

/** A bulk change acts on at most this many tasks per confirmation. */
export const BULK_CAP = 25;

/* ------------------------------------------------------------------ shared */

/**
 * Moves tasks by `days`: due date and planned slot shift together. A subtask whose parent is in the same
 * batch is skipped (moving the parent already moves its children). No due date and no slot: due `days` from today.
 */
export async function shiftTasks(turn: Turn, tasks: Task[], days: number, reason?: string): Promise<Task[]> {
  const ids = new Set(tasks.map((t) => t.id));
  const shift = days * 86400000;
  const moved: Task[] = [];
  for (const t of tasks) {
    if (t.parentTaskId && ids.has(t.parentTaskId)) continue;
    const updated = await updateTask(turn.task, t.id, {
      dueDate: t.dueDate ? new Date(t.dueDate.getTime() + shift) : t.scheduledStart ? null : dueDateFromYmd(addDaysYmd(turn.todayYmd, days), turn.tz),
      scheduledStart: t.scheduledStart ? new Date(t.scheduledStart.getTime() + shift) : null,
      scheduledEnd: t.scheduledEnd ? new Date(t.scheduledEnd.getTime() + shift) : null,
    });
    if (!updated) continue;
    moved.push(updated);
    logEvent(turn.user.id, "TASK_POSTPONED", t.id, { days, ...(reason ? { reason } : {}) });
  }
  return moved;
}

/** Not urgent, not fixed, due by tomorrow: what "postpone non-urgent" moves (FR-MH-003). */
export function nonUrgentSoon(turn: Turn, tasks: Task[]): Task[] {
  const end = startOfLocalDay(addDaysYmd(turn.todayYmd, 2), turn.tz);
  return tasks.filter((t) => t.priority !== Priority.URGENT && t.taskType !== TaskType.FIXED && t.dueAt && t.dueAt < end);
}

/** The preview: one question, the titles (WhatsApp: first 8 + "…and N more"), one confirmation. */
function preview(turn: Turn, question: string, tasks: Task[], total: number): Prepared {
  const c = commandText(turn.settings.language);
  const whatsapp = isWhatsapp(turn.channel);
  const shownTitles = tasks.slice(0, whatsapp ? WHATSAPP_LIST_CAP : BULK_CAP).map((t) => `• ${t.title}`);
  const extra = tasks.length - shownTitles.length;
  const capped = total > tasks.length ? `\n${c.bulkCapped(BULK_CAP, total)}` : "";
  return {
    args: { taskIds: tasks.map((t) => t.id) },
    confirm: {
      question: [question, ...shownTitles, ...(extra > 0 ? [c.bulkMore(extra)] : [])].join("\n") + capped,
      cards: whatsapp ? [] : [{ type: "task_list", title: c.cardWillChange, tasks: tasks.map((t) => serializeTask(t, turn.now)) }],
    },
  };
}

async function tasksByIds(turn: Turn, args: CommandArgs): Promise<Task[]> {
  const ids = Array.isArray(args.taskIds) ? (args.taskIds as string[]).slice(0, BULK_CAP) : [];
  const rows = await Promise.all(ids.map((id) => getTaskForUser(turn.user.id, id)));
  return rows.filter((t): t is Task => Boolean(t));
}

const nothing = (content: string, intent: string): Prepared => ({ out: { content, intent } });
const tx = (turn: Turn) => commandText(turn.settings.language);
const day = (turn: Turn, ymd: string) => dayLabelFor(turn.settings.language, relativeDayLabel(ymd, turn.todayYmd));

/* ------------------------------------------------------------------ commands */

const MOVE = `${MOVE_WORDS}|daal do|dal do|${DO_IT}|منتقل|ڈال دو`;
const TODAY_SOURCE = /\b(?:today'?s|todays|today|tonight|from today|aaj\s+(?:ke|ki|ka)|aaj)\b|آج\s+(?:کے|کی|کا)|آج/gi;

const moveToday: Command = {
  name: "bulk_move_today",
  category: "bulk",
  summary: "Move everything due today to another day (preview, one confirmation, undo)",
  examples: ["Move all of today's tasks to tomorrow", "aaj ke saare kaam kal kar do"],
  schema: z.object({ toYmd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), taskIds: z.array(z.string()).optional() }).passthrough(),
  undoable: true,
  parse(text, ctx) {
    const t = norm(text);
    const clear = /^(?:please )?(?:clear|free up|empty|cancel) (?:my |the )?(?:day|today|whole day|schedule today|plans today)$/.test(t);
    // CHAT_FIXES_V2: "move everything to tomorrow" means today's tasks even without the word "today".
    const everything = chatFixesOn() && has(t, MOVE) && /\b(?:everything|all of it|all of today|all my tasks|all tasks|all my stuff|today'?s? (?:tasks?|todos?|to dos?|stuff|work|list|plans?|schedule))\b/.test(t) && !groupIn(text);
    if (!clear && !everything && (addBeforeMove(t) || !(has(t, MOVE) && has(t, ALL) && has(t, TODAY) && has(t, `${TASK_WORD}|everything|sab|سب|سارے`)))) return null;
    if (has(t, "non urgent|nonurgent|not urgent|less important|ghair zaroori|غیر ضروری")) return null;
    const target = extractTargetDay(text.replace(TODAY_SOURCE, " "), ctx.opts);
    const toYmd = target && target > ctx.todayYmd ? target : addDaysYmd(ctx.todayYmd, 1);
    return { toYmd };
  },
  async prepare(turn, args) {
    const end = startOfLocalDay(addDaysYmd(turn.todayYmd, 1), turn.tz);
    const start = startOfLocalDay(turn.todayYmd, turn.tz);
    const today = (await listActiveTasks(turn.user.id)).filter((t) => (t.dueAt && t.dueAt >= start && t.dueAt < end) || (t.scheduledStart && t.scheduledStart >= start && t.scheduledStart < end));
    if (!today.length) return nothing(tx(turn).bulkNothingToday, "bulk_nothing");
    const toYmd = String(args.toYmd);
    const list = today.slice(0, BULK_CAP);
    const p = preview(turn, tx(turn).bulkMovePreview(list.length, day(turn, toYmd)), list, today.length);
    return "args" in p ? { ...p, args: { ...p.args, toYmd } } : p;
  },
  async execute(turn, args) {
    const tasks = await tasksByIds(turn, args);
    const toYmd = String(args.toYmd);
    const moved = await shiftTasks(turn, tasks, diffDaysYmd(turn.todayYmd, toYmd), "bulk_move_today");
    recordUndo(turn, { kind: "tasks", op: "edit", taskIds: moved.map((t) => t.id), before: snapshots(tasks), label: `${plural(moved.length, "task")} moved` });
    return { content: tx(turn).bulkMoved(moved.length, day(turn, toYmd)), cards: [{ type: "task_list", title: tx(turn).cardMoved, tasks: moved.map((t) => serializeTask(t, turn.now)) }], actions: [undoAction(turn.settings.language)], intent: "bulk_moved" };
  },
};

const DONE_VERB = "complete|finish|mark|done|tick off|check off|mukammal|مکمل";
const tagIn = (text: string) =>
  (/#([\p{L}\p{N}_-]+)/u.exec(text) ?? /\btagged\s+([\p{L}\p{N}_-]+)/iu.exec(text) ?? /\b(?:with\s+)?(?:the\s+)?tag\s+([\p{L}\p{N}_-]+)/iu.exec(text) ?? /([\p{L}\p{N}_-]+)\s+(?:tag|ٹیگ)\s+(?:wale|wali|والے|والی)/iu.exec(text))?.[1]?.toLowerCase() ?? null;

const completeTag: Command = {
  name: "bulk_complete_tag",
  category: "bulk",
  summary: "Complete every open task with a tag (preview, one confirmation, undo)",
  examples: ["Complete all tasks tagged #uni", "saare #uni wale kaam done kar do"],
  schema: z.object({ tag: z.string().min(1).max(30), taskIds: z.array(z.string()).optional() }).passthrough(),
  undoable: true,
  parse(text) {
    const t = norm(text);
    if (!has(t, DONE_VERB) || !has(t, ALL)) return null;
    const tag = tagIn(text);
    return tag ? { tag } : null;
  },
  async prepare(turn, args) {
    const tag = String(args.tag).toLowerCase();
    const tagged = (await listActiveTasks(turn.user.id)).filter((t) => Array.isArray(t.tags) && (t.tags as string[]).includes(tag));
    if (!tagged.length) return nothing(tx(turn).bulkNoTag(tag), "bulk_nothing");
    const list = tagged.slice(0, BULK_CAP);
    const p = preview(turn, tx(turn).bulkTagPreview(list.length, tag), list, tagged.length);
    return "args" in p ? { ...p, args: { ...p.args, tag } } : p;
  },
  async execute(turn, args) {
    const tasks = await tasksByIds(turn, args);
    const done: Task[] = [];
    for (const t of tasks) {
      const u = await updateTask(turn.task, t.id, { status: TaskStatus.COMPLETED });
      if (u) done.push(u);
    }
    recordUndo(turn, { kind: "tasks", op: "edit", taskIds: done.map((t) => t.id), before: snapshots(tasks), label: `${plural(done.length, "task")} completed` });
    return { content: tx(turn).bulkTagDone(done.length, String(args.tag)), cards: [{ type: "task_list", title: tx(turn).cardCompleted, tasks: done.map((t) => serializeTask(t, turn.now)) }], actions: [undoAction(turn.settings.language)], intent: "bulk_completed" };
  },
};

const deleteCompleted: Command = {
  name: "bulk_delete_completed",
  category: "bulk",
  summary: "Delete all completed tasks (preview, one confirmation, undo 24 hours)",
  examples: ["Delete all completed tasks", "Clear my completed tasks"],
  schema: z.object({ taskIds: z.array(z.string()).optional() }).passthrough(),
  undoable: true,
  parse(text) {
    const t = norm(text);
    if (!has(t, `delete|remove|clear|clean up|get rid of|hata do|hatao|saaf|ڈیلیٹ|ہٹا دو|صاف${chatFixesOn() ? `|${MORE_DELETE}` : ""}`)) return null;
    if (!has(t, "completed|done|finished|mukammal|مکمل")) return null;
    // CHAT_FIXES_V2: "the completed ones", "the finished stuff" name the same group.
    return has(t, ALL) || has(t, "tasks|kaam|کام") || (chatFixesOn() && has(t, "ones|stuff|items|things")) ? {} : null;
  },
  async prepare(turn) {
    const done = await prisma.task.findMany({ where: { userId: turn.user.id, status: TaskStatus.COMPLETED }, orderBy: { completedAt: "asc" }, take: 200 });
    if (!done.length) return nothing(tx(turn).bulkNoCompleted, "bulk_nothing");
    const list = done.slice(0, BULK_CAP);
    return preview(turn, tx(turn).bulkDeletePreview(list.length), list, done.length);
  },
  async execute(turn, args) {
    const tasks = await tasksByIds(turn, args);
    const deleted: string[] = [];
    for (const t of tasks) if (await softDeleteTask(turn.task, t.id)) deleted.push(t.id);
    recordUndo(turn, { kind: "tasks", op: "delete", taskIds: deleted, label: `${plural(deleted.length, "completed task")} deleted` });
    return { content: tx(turn).bulkDeleted(deleted.length), actions: [undoAction(turn.settings.language)], intent: "bulk_deleted" };
  },
};

/** "Remove all the pending tasks", "delete all my tasks", "saare kaam delete kar do". Never completed ones, a day or a tag. */
const DELETE_ALL_OPEN = [
  /^(?:please )?(?:delete|remove|clear|erase|get rid of|cancel) (?:all|every|everything)(?: of)?(?: the| my)?(?: (?:pending|existing|open|remaining|current|active|incomplete|undone|unfinished))?(?: (?:tasks?|todos?|to dos?))?(?: please)?$/,
  /^(?:please )?(?:mere )?(?:saare|sare|saari|sari|sab|tamam|tamaam)(?: ke sab)?(?: pending)? (?:kaam|kam|tasks?) (?:delete|hata|khatam|remove) (?:kar )?(?:do|dein|den)?$/,
];

const deleteOpen: Command = {
  name: "bulk_delete_open",
  category: "bulk",
  summary: "Delete all open tasks (preview, one confirmation, undo 24 hours)",
  examples: ["Remove all the pending tasks", "Delete all my tasks", "saare kaam delete kar do"],
  schema: z.object({ taskIds: z.array(z.string()).optional() }).passthrough(),
  undoable: true,
  parse(text) {
    const t = norm(text);
    return DELETE_ALL_OPEN.some((re) => re.test(t)) ? {} : null;
  },
  async prepare(turn) {
    const open = await listActiveTasks(turn.user.id);
    if (!open.length) return nothing(tx(turn).bulkNoOpen, "bulk_nothing");
    const list = open.slice(0, BULK_CAP);
    return preview(turn, tx(turn).bulkDeletePreview(list.length, true), list, open.length);
  },
  async execute(turn, args) {
    const tasks = await tasksByIds(turn, args);
    const deleted: string[] = [];
    for (const t of tasks) if (await softDeleteTask(turn.task, t.id)) deleted.push(t.id);
    recordUndo(turn, { kind: "tasks", op: "delete", taskIds: deleted, label: `${plural(deleted.length, "task")} deleted` });
    return { content: tx(turn).bulkDeleted(deleted.length, true), actions: [undoAction(turn.settings.language)], intent: "bulk_deleted" };
  },
};

const postponeNonUrgent: Command = {
  name: "bulk_postpone_nonurgent",
  category: "bulk",
  summary: "Move non-urgent tasks due by tomorrow one day later (preview, one confirmation, undo)",
  examples: ["Postpone all non-urgent tasks", "ghair zaroori kaam kal pe daal do"],
  schema: z.object({ taskIds: z.array(z.string()).optional() }).passthrough(),
  undoable: true,
  parse(text) {
    const t = norm(text);
    return !addBeforeMove(t) && has(t, `${MOVE}|aage kar|aage karo`) && has(t, "non urgent|nonurgent|not urgent|less important|unimportant|ghair zaroori|ghair zaruri|jo zaroori nahi|غیر ضروری") ? {} : null;
  },
  async prepare(turn) {
    const all = nonUrgentSoon(turn, await listActiveTasks(turn.user.id));
    if (!all.length) return nothing(tx(turn).bulkNoNonUrgent, "bulk_nothing");
    const list = all.slice(0, BULK_CAP);
    return preview(turn, tx(turn).bulkPostponePreview(list.length), list, all.length);
  },
  async execute(turn, args) {
    const tasks = await tasksByIds(turn, args);
    const moved = await shiftTasks(turn, tasks, 1, "nonurgent");
    recordUndo(turn, { kind: "tasks", op: "edit", taskIds: moved.map((t) => t.id), before: snapshots(tasks), label: `${plural(moved.length, "task")} postponed` });
    return { content: tx(turn).bulkPostponed(moved.length), cards: [{ type: "task_list", title: tx(turn).cardPostponed, tasks: moved.map((t) => serializeTask(t, turn.now)) }], actions: [undoAction(turn.settings.language)], intent: "bulk_postponed" };
  },
};

/* ------------------------------------------------------------------ CHAT_FIXES_V2: a group of tasks by tag or category */

const NOT_A_GROUP = new Set(["tasks", "task", "todos", "today", "todays", "everything", "it", "them", "of", "completed", "done", "finished", "open", "pending", "remaining", "the", "my", "stuff", "things", "items"]);

/** "all my errands", "every uni task": a word naming a group (a tag or a category), never "all my tasks". */
export function groupIn(text: string): string | null {
  const m = /\b(?:all|every|each)\s+(?:of\s+)?(?:my\s+|the\s+)?([a-z][a-z-]{2,30})(?:\s+(?:tasks?|todos?))?\b/i.exec(text);
  const word = m?.[1]?.toLowerCase();
  return word && !NOT_A_GROUP.has(word) ? word : null;
}

/** Open tasks tagged with the group or filed under it (singular or plural). */
async function groupTasks(turn: Turn, group: string): Promise<Task[]> {
  const forms = new Set([group, group.replace(/s$/, "")]);
  return (await listActiveTasks(turn.user.id)).filter(
    (t) => (Array.isArray(t.tags) && (t.tags as string[]).some((g) => forms.has(String(g).toLowerCase()))) || (t.category && forms.has(t.category.toLowerCase())),
  );
}

const moveGroup: Command = {
  name: "bulk_move_group",
  category: "bulk",
  enabled: chatFixesOn,
  summary: "Move every open task in a group (tag or category) to another day (preview, one confirmation, undo)",
  examples: ["Push all my errands to Friday"],
  schema: z.object({ group: z.string().min(1).max(30), toYmd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), taskIds: z.array(z.string()).optional() }).passthrough(),
  undoable: true,
  parse(text, ctx) {
    if (!chatFixesOn()) return null;
    const t = norm(text);
    const group = groupIn(text);
    if (!group || !has(t, MOVE)) return null;
    const target = extractTargetDay(text, ctx.opts);
    return target && target > ctx.todayYmd ? { group, toYmd: target } : null;
  },
  async prepare(turn, args) {
    const group = String(args.group);
    const tasks = await groupTasks(turn, group);
    if (!tasks.length) return nothing(`No open tasks are tagged or filed under "${group}".`, "bulk_nothing");
    const list = tasks.slice(0, BULK_CAP);
    const toYmd = String(args.toYmd);
    const p = preview(turn, `Move ${plural(list.length, "task")} in "${group}" to ${day(turn, toYmd)}?`, list, tasks.length);
    return "args" in p ? { ...p, args: { ...p.args, group, toYmd } } : p;
  },
  async execute(turn, args) {
    const tasks = await tasksByIds(turn, args);
    const toYmd = String(args.toYmd);
    // Each task keeps its time of day and lands on the target day.
    const moved: Task[] = [];
    for (const t of tasks) moved.push(...(await shiftTasks(turn, [t], diffDaysYmd(t.dueAt ? localYmdOf(turn, t.dueAt) : turn.todayYmd, toYmd), "bulk_move_group")));
    recordUndo(turn, { kind: "tasks", op: "edit", taskIds: moved.map((t) => t.id), before: snapshots(tasks), label: `${plural(moved.length, "task")} moved` });
    return { content: `Moved ${plural(moved.length, "task")} to ${day(turn, toYmd)}.`, cards: [{ type: "task_list", title: tx(turn).cardMoved, tasks: moved.map((t) => serializeTask(t, turn.now)) }], actions: [undoAction(turn.settings.language)], intent: "bulk_moved" };
  },
};

const deleteGroup: Command = {
  name: "bulk_delete_group",
  category: "bulk",
  enabled: chatFixesOn,
  summary: "Delete every open task in a group (tag or category) (preview, one confirmation, undo 24 hours)",
  examples: ["Delete all my errands"],
  schema: z.object({ group: z.string().min(1).max(30), taskIds: z.array(z.string()).optional() }).passthrough(),
  undoable: true,
  parse(text) {
    if (!chatFixesOn()) return null;
    const t = norm(text);
    const group = groupIn(text);
    if (!group || !has(t, `delete|remove|clear|get rid of|erase|cancel|${MORE_DELETE}`) || has(t, "completed|done|finished")) return null;
    return { group };
  },
  async prepare(turn, args) {
    const group = String(args.group);
    const tasks = await groupTasks(turn, group);
    if (!tasks.length) return nothing(`No open tasks are tagged or filed under "${group}".`, "bulk_nothing");
    const list = tasks.slice(0, BULK_CAP);
    const p = preview(turn, `Delete ${plural(list.length, "task")} in "${group}"? You can undo this for 24 hours.`, list, tasks.length);
    return "args" in p ? { ...p, args: { ...p.args, group } } : p;
  },
  async execute(turn, args) {
    const tasks = await tasksByIds(turn, args);
    const deleted: string[] = [];
    for (const t of tasks) if (await softDeleteTask(turn.task, t.id)) deleted.push(t.id);
    recordUndo(turn, { kind: "tasks", op: "delete", taskIds: deleted, label: `${plural(deleted.length, "task")} deleted` });
    return { content: `Deleted ${plural(deleted.length, "task")} in "${String(args.group)}". You can undo this for 24 hours.`, actions: [undoAction(turn.settings.language)], intent: "bulk_deleted" };
  },
};

const localYmdOf = (turn: Turn, d: Date) => localYmd(d, turn.tz);

export const bulkCommands: Command[] = [postponeNonUrgent, moveToday, completeTag, deleteCompleted, deleteOpen, moveGroup, deleteGroup];

