import { ReminderMode, TaskSource, TaskStatus, TaskType, type Task } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../../config/db.js";
import { fuzzySimilarity, listJoin, truncate } from "../../../lib/text.js";
import { PREDEFINED_CATEGORIES } from "../../settings/settingsRoutes.js";
import { createTask, getTaskForUser, listSubtasks, updateTask } from "../../tasks/taskService.js";
import { focusOn, taskCard, type Out, type Turn } from "../dialogue.js";
import { resolveTaskRef } from "../draft.js";
import { extractEntities } from "../entities.js";
import { handlePayload } from "../handlers.js";
import { ASK, DO_IT, ROUTINE, TASK_WORD, capture, has, norm, refFrom, splitList } from "./lexicon.js";
import { askChoice, recordUndo, runCommand, snapshots, UNDO_ACTION } from "./runtime.js";
import type { Command, CommandArgs, Prepared } from "./types.js";

const taskRef = z.object({ ref: z.string().max(120).default(""), taskId: z.string().uuid().optional(), text: z.string().max(1000).optional() }).passthrough();

const cleanRef = (ref: string | null | undefined) => refFrom(ref ?? "", TASK_WORD);

/* ------------------------------------------------------------------ resolution */

/**
 * The task the user named (fuzzy, "it" = the focused task). Several → "which one?"; none → `fallback`
 * (e.g. "start studying physics" is a new task, not an existing one) or a not-found reply.
 */
async function prepareTask(turn: Turn, command: string, args: CommandArgs, opts: { includeCompleted?: boolean; fallback?: string } = {}): Promise<Prepared> {
  if (typeof args.taskId === "string" && (await getTaskForUser(turn.user.id, args.taskId))) return { args };
  const ref = String(args.ref ?? "");
  const r = await resolveTaskRef(turn.user.id, ref, turn.state.focus, { includeCompleted: opts.includeCompleted });
  if (r.task) return { args: { ...args, taskId: r.task.id } };
  if (r.candidates.length && ref) return { out: askChoice(turn, command, args, "taskId", r.candidates.map((t) => ({ id: t.id, label: t.title })), "Which task do you mean?") };
  if (opts.fallback && args.text) return { out: await runCommand(turn, opts.fallback, { text: args.text }) };
  return { out: { content: ref ? `I couldn't find a task matching "${ref}".` : "Which task do you mean?", actions: [{ label: "Show my tasks", text: "Show my tasks" }], intent: "not_found" } };
}

async function taskOf(turn: Turn, args: CommandArgs): Promise<Task | null> {
  return getTaskForUser(turn.user.id, String(args.taskId));
}

const gone: Out = { content: "I couldn't find that task anymore.", intent: "not_found" };

/** Saves a change, focuses the task and records the undo step (task version history). */
async function edit(turn: Turn, task: Task, changes: Parameters<typeof updateTask>[2], label: string): Promise<Task | null> {
  const updated = await updateTask(turn.task, task.id, changes);
  if (!updated) return null;
  focusOn(turn, updated.id);
  recordUndo(turn, { kind: "tasks", op: "edit", taskIds: [updated.id], before: snapshots([task]), label });
  return updated;
}

/* ------------------------------------------------------------------ notes */

const NOTE_PATTERNS: Array<{ re: RegExp; replace?: boolean; refFirst?: boolean }> = [
  { re: /^(?:please\s+)?(?:add|put|write|save|attach)\s+(?:a\s+|the\s+)?(?:note|notes|description)\s+(?:to|on|for|in|under)\s+(.+?)\s*[:\-–]\s*(.+)$/i },
  { re: /^(?:a\s+)?note\s+(?:for|on|to)\s+(.+?)\s*[:\-–]\s*(.+)$/i },
  { re: /^(?:please\s+)?(?:set|change|update|make)\s+(?:the\s+)?(?:description|notes?)\s+(?:of|for|on)\s+(.+?)\s+(?:to|as)\s+(.+)$/i, replace: true },
  { re: /^(.+?)\s+(?:mein|me|main|par|pe)\s+(?:note|notes)\s+(?:likho|likh\s*do|add\s*karo|add\s*kar\s*do|daal\s*do|dal\s*do|daalo)\s*[:\-–]?\s*(.+)$/i },
  { re: /^(.+?)\s+(?:میں|پر)\s+نوٹ\s+(?:لکھو|لکھ دو|شامل کرو|ڈال دو)\s*[:،]?\s*(.+)$/ },
];

const taskNotes: Command = {
  name: "task_notes",
  category: "tasks",
  summary: "Add a note or description to a task",
  examples: ["Add a note to the essay: bring printouts", "essay mein note likho: printouts le jana"],
  schema: taskRef.extend({ note: z.string().min(1).max(2000), replace: z.boolean().optional() }),
  undoable: true,
  parse(text) {
    const t = text.trim();
    for (const p of NOTE_PATTERNS) {
      const m = p.re.exec(t);
      if (m) return { ref: cleanRef(m[1]), note: m[2].trim(), ...(p.replace ? { replace: true } : {}) };
    }
    const bare = capture(t, /^(?:please\s+)?(?:add|put)\s+(?:a\s+)?note\s*[:\-–]\s*(.+)$/i);
    return bare ? { ref: "", note: bare } : null;
  },
  prepare: (turn, args) => prepareTask(turn, "task_notes", args, { includeCompleted: true }),
  async execute(turn, args) {
    const task = await taskOf(turn, args);
    if (!task) return gone;
    const note = String(args.note).trim();
    const description = args.replace || !task.description ? note : `${task.description}\n${note}`;
    const updated = await edit(turn, task, { description }, `note on "${task.title}"`);
    if (!updated) return gone;
    return { content: `${args.replace ? "Description set" : "Note added"} on "${updated.title}": ${truncate(note, 140)}`, cards: [taskCard(updated, undefined, true)], actions: [UNDO_ACTION], intent: "task_note_added" };
  },
};

/* ------------------------------------------------------------------ reminder mode */

const REMIND = "remind|reminders|reminder|reminding|notifications|notification|alerts|alert|yaad dihani|ریمائنڈر|ریمائنڈرز|یاد دہانی";
const MODES: Array<{ mode: ReminderMode; words: string }> = [
  { mode: ReminderMode.NONE, words: "no reminders|no reminder|turn off|switch off|stop reminding|dont remind|do not remind|mute|silence|off|band|بند|nahi chahiye|mat" },
  { mode: ReminderMode.ESCALATING, words: "keep reminding|keep nagging|nag me|escalating|escalate|increasing|until i do it" },
  { mode: ReminderMode.MULTIPLE, words: "multiple|several|many|more reminders|a few reminders|kai baar|bar bar|baar baar|کئی بار|بار بار" },
  { mode: ReminderMode.SINGLE, words: "only once|just once|once|one reminder|single reminder|single|ek baar|ek hi baar|ایک بار" },
  { mode: ReminderMode.ADAPTIVE, words: "adaptive|smart reminders|automatic|default reminders|normal reminders|usual reminders" },
];
const MODE_LABEL: Record<ReminderMode, string> = {
  NONE: "no reminders",
  SINGLE: "one reminder",
  MULTIPLE: "several reminders",
  ESCALATING: "escalating reminders (more often as the deadline gets close)",
  ADAPTIVE: "smart reminders (the default)",
};

const taskReminderMode: Command = {
  name: "task_reminder_mode",
  category: "tasks",
  summary: "Choose a task's reminders: none, once, several, escalating or smart",
  examples: ["Turn off reminders for the essay", "Remind me about the lab report only once"],
  schema: taskRef.extend({ mode: z.nativeEnum(ReminderMode) }),
  undoable: true,
  parse(text, ctx) {
    const t = norm(text);
    if (!has(t, REMIND) || has(t, "whatsapp|whats app|phone|mobile|app|both|dono|واٹس ایپ|فون|دونوں")) return null;
    const e = extractEntities(text, ctx.opts);
    if (e.date || e.timeExplicit) return null; // a new reminder with a date/time is a new task
    const hit = MODES.find((m) => has(t, m.words));
    if (!hit) return null;
    const ref = refFrom(text, `${REMIND}|${MODES.map((m) => m.words).join("|")}|use|turn|set|give|send|keep|about|for|on|of|${DO_IT}`);
    return ref ? { ref, mode: hit.mode, text } : null;
  },
  async prepare(turn, args) {
    // "remind me to call mom once" with no such task is a new task.
    return prepareTask(turn, "task_reminder_mode", args, { fallback: /^\s*remind me to\b/i.test(String(args.text ?? "")) ? "create_task" : undefined });
  },
  async execute(turn, args) {
    const task = await taskOf(turn, args);
    if (!task) return gone;
    const mode = args.mode as ReminderMode;
    const updated = await edit(turn, task, { reminderMode: mode }, `reminders for "${task.title}"`);
    if (!updated) return gone;
    return { content: `"${updated.title}" now has ${MODE_LABEL[mode]}.`, cards: [taskCard(updated, undefined, true)], actions: [UNDO_ACTION], intent: "task_reminder_mode" };
  },
};

/* ------------------------------------------------------------------ start / reopen */

const START_PATTERNS = [
  /^(?:ok(?:ay)?[,\s]+)?(?:(?:i'?m|i am|let'?s|lets)\s+)?(?:start(?:ing)?|begin(?:ning)?|work(?:ing)?\s+on|get(?:ting)?\s+started\s+(?:on|with)|kick(?:ing)?\s+off)\s+(?:on\s+|with\s+|working\s+on\s+)?(.+?)(?:\s+(?:now|right now))?[.!]*$/i,
  /^(.+?)\s+(?:shuru|start)\s+(?:kar\s*(?:raha|rahi|rha|rhi)\s*(?:hoon|hun|hu|hon)|kart[ai]\s+(?:hoon|hun)|kar\s*do|karo|kar\s*diya|kar\s*di)[.!]*$/i,
  /^(.+?)\s+شروع\s+(?:کر\s+(?:رہا|رہی)\s+(?:ہوں|ہو)|کرو|کر دو|کرتا ہوں|کرتی ہوں)[۔.!]*$/,
];

const taskStart: Command = {
  name: "task_start",
  category: "tasks",
  summary: "Start a task (in progress, with a focus block)",
  examples: ["Start the essay", "essay shuru kar raha hoon"],
  schema: taskRef,
  undoable: true,
  parse(text, ctx) {
    const t = text.trim();
    const ref = START_PATTERNS.map((re) => re.exec(t)?.[1]).find(Boolean);
    if (!ref || has(norm(t), ROUTINE)) return null;
    if (/^(?:a|an|new|my day|the day|today|the timer|timer|over|again|from scratch|planning|a new task)\b/i.test(ref)) return null;
    const e = extractEntities(text, ctx.opts);
    if (e.date || e.timeExplicit || e.frequency) return null; // "start studying tomorrow at 5" is a new task
    const cleaned = cleanRef(ref);
    return cleaned ? { ref: cleaned, text } : null;
  },
  prepare: (turn, args) => prepareTask(turn, "task_start", args, { fallback: "create_task" }),
  async execute(turn, args) {
    const task = await taskOf(turn, args);
    if (!task) return gone;
    const out = await handlePayload(turn, { type: "start_task", taskId: task.id });
    recordUndo(turn, { kind: "tasks", op: "edit", taskIds: [task.id], before: snapshots([task]), label: `started "${task.title}"` });
    return { ...out, actions: [...(out.actions ?? []), UNDO_ACTION] };
  },
};

const REOPEN_PATTERNS = [
  /^(?:please\s+)?(?:re-?open|un-?complete|uncheck|untick|un-?finish)\s+(.+)$/i,
  /^(?:please\s+)?mark\s+(.+?)\s+(?:as\s+)?(?:not\s+done|not\s+finished|not\s+complete|incomplete|undone|unfinished|pending|open|to\s?do)$/i,
  /^(.+?)\s+(?:isn'?t|is\s+not|wasn'?t)\s+(?:done|finished|complete)(?:\s+yet)?(?:,?\s*(?:re-?open|undo)\s+it)?$/i,
  /^(.+?)\s+(?:dobara|dubara|wapas|phir\s+se)\s+(?:khol|khole|kholo|pending|open)\s*(?:do|dein|kar\s*do|karo)?$/i,
  /^(.+?)\s+abhi\s+(?:mukammal|complete|done)\s+nahi(?:\s+(?:hua|hui|hai))?$/i,
  /^(.+?)\s+(?:دوبارہ|واپس)\s+(?:کھول|کھولو)\s*(?:دو|دیں)?$/,
];

const taskReopen: Command = {
  name: "task_reopen",
  category: "tasks",
  summary: "Reopen a completed task",
  examples: ["Reopen the essay", "essay dobara khol do"],
  schema: taskRef,
  undoable: true,
  parse(text) {
    const t = text.trim().replace(/[.!]+$/, "");
    const ref = REOPEN_PATTERNS.map((re) => re.exec(t)?.[1]).find(Boolean);
    return ref ? { ref: cleanRef(ref) } : null;
  },
  async prepare(turn, args) {
    const p = await prepareTask(turn, "task_reopen", args, { includeCompleted: true });
    if ("out" in p) return p;
    const task = await taskOf(turn, p.args);
    if (task && task.status !== TaskStatus.COMPLETED && task.status !== TaskStatus.SKIPPED) return { out: { content: `"${task.title}" is already open.`, intent: "task_reopen" } };
    return p;
  },
  async execute(turn, args) {
    const task = await taskOf(turn, args);
    if (!task) return gone;
    const updated = await edit(turn, task, { status: TaskStatus.PENDING, archived: false }, `reopened "${task.title}"`);
    if (!updated) return gone;
    return { content: `Reopened "${updated.title}" (${updated.progress}% done).`, cards: [taskCard(updated, undefined, true)], actions: [UNDO_ACTION], intent: "task_reopened" };
  },
};

/* ------------------------------------------------------------------ tags and category */

const tagList = (s: string) => splitList(s).map((x) => x.replace(/^#/, "").toLowerCase().replace(/[^\w-]/g, "")).filter(Boolean);

const TAG_PATTERNS: Array<{ re: RegExp; op: "add" | "remove"; tagsFirst: boolean }> = [
  { re: /^(?:please\s+)?add\s+(?:the\s+|a\s+)?tags?\s+(.+?)\s+(?:to|on)\s+(.+)$/i, op: "add", tagsFirst: true },
  { re: /^(?:please\s+)?tag\s+(.+?)\s+(?:as|with)\s+(.+)$/i, op: "add", tagsFirst: false },
  { re: /^(.+?)\s+(?:par|pe|ko)\s+(.+?)\s+(?:ka\s+)?tag\s+(?:laga\s*do|lagao|laga\s*dein|add\s*karo|add\s*kar\s*do|daal\s*do|dal\s*do)$/i, op: "add", tagsFirst: false },
  { re: /^(.+?)\s+(?:پر|کو)\s+(.+?)\s+(?:کا\s+)?ٹیگ\s+(?:لگا دو|لگاؤ|لگا دیں)$/, op: "add", tagsFirst: false },
  { re: /^(?:please\s+)?(?:remove|delete|drop|take\s+off)\s+(?:the\s+)?tags?\s+(.+?)\s+from\s+(.+)$/i, op: "remove", tagsFirst: true },
  { re: /^(?:please\s+)?untag\s+(#\S+(?:\s*(?:,|and)\s*#\S+)*)\s+from\s+(.+)$/i, op: "remove", tagsFirst: true },
  { re: /^(?:please\s+)?untag\s+(.+?)\s+(?:from\s+)?(#\S+)$/i, op: "remove", tagsFirst: false },
  { re: /^(.+?)\s+se\s+(.+?)\s+(?:ka\s+)?tag\s+(?:hata\s*do|hatao|nikal\s*do|hata\s*dein|remove\s*karo)$/i, op: "remove", tagsFirst: false },
  { re: /^(.+?)\s+سے\s+(.+?)\s+(?:کا\s+)?ٹیگ\s+(?:ہٹا دو|ہٹاؤ|نکال دو)$/, op: "remove", tagsFirst: false },
];

const taskTags: Command = {
  name: "task_tags",
  category: "tasks",
  summary: "Add or remove tags on a task",
  examples: ["Add tag uni to the essay", "Remove the tag uni from the essay"],
  schema: taskRef.extend({ add: z.array(z.string().max(30)).max(10).default([]), remove: z.array(z.string().max(30)).max(10).default([]) }),
  undoable: true,
  parse(text) {
    const t = text.trim().replace(/[.!]+$/, "");
    for (const p of TAG_PATTERNS) {
      const m = p.re.exec(t);
      if (!m) continue;
      const [tags, ref] = p.tagsFirst ? [m[1], m[2]] : [m[2], m[1]];
      const list = tagList(tags);
      if (!list.length) return null;
      return { ref: cleanRef(ref), add: p.op === "add" ? list : [], remove: p.op === "remove" ? list : [] };
    }
    return null;
  },
  prepare: (turn, args) => prepareTask(turn, "task_tags", args, { includeCompleted: true }),
  async execute(turn, args) {
    const task = await taskOf(turn, args);
    if (!task) return gone;
    const current = Array.isArray(task.tags) ? (task.tags as string[]) : [];
    const add = (args.add as string[]) ?? [];
    const remove = (args.remove as string[]) ?? [];
    const missing = remove.filter((r) => !current.includes(r));
    const next = [...new Set([...current.filter((c) => !remove.includes(c)), ...add])];
    if (JSON.stringify(next) === JSON.stringify(current)) {
      return { content: missing.length ? `"${task.title}" doesn't have the tag ${missing.map((m) => `#${m}`).join(" ")}.` : `"${task.title}" already has ${add.map((a) => `#${a}`).join(" ")}.`, intent: "task_tags" };
    }
    const updated = await edit(turn, task, { tags: next }, `tags on "${task.title}"`);
    if (!updated) return gone;
    return { content: `"${updated.title}" tags: ${next.length ? next.map((x) => `#${x}`).join(" ") : "none"}.`, cards: [taskCard(updated, undefined, true)], actions: [UNDO_ACTION], intent: "task_tags_updated" };
  },
};

const CATEGORY_PATTERNS = [
  /^(?:please\s+)?(?:put|move|file|add|place)\s+(.+?)\s+(?:in|into|under|to)\s+(?:the\s+)?(.+?)\s+category$/i,
  /^(?:please\s+)?(?:set|change|update|make)\s+(?:the\s+)?category\s+(?:of|for|on)\s+(.+?)\s+(?:to|as)\s+(.+)$/i,
  /^(?:please\s+)?(?:categori[sz]e|file)\s+(.+?)\s+(?:as|under|in)\s+(.+)$/i,
  /^(.+?)\s+(?:is|goes\s+under|belongs\s+(?:to|in))\s+(?:the\s+)?(.+?)\s+category$/i,
  /^(.+?)\s+(?:ki|ka|ke)\s+category\s+(.+?)\s+(?:kar\s*do|karo|rakh\s*do|rakho|set\s*karo|set\s*kar\s*do|bana\s*do)$/i,
  /^(.+?)\s+(?:کی|کا)\s+کیٹیگری\s+(.+?)\s+(?:کر دو|کرو|رکھ دو)$/,
];

const taskCategory: Command = {
  name: "task_category",
  category: "tasks",
  summary: "Change a task's category",
  examples: ["Put the essay in the Academic category", "essay ki category Academic kar do"],
  schema: taskRef.extend({ category: z.string().min(1).max(60) }),
  undoable: true,
  parse(text) {
    const t = text.trim().replace(/[.!]+$/, "");
    for (const re of CATEGORY_PATTERNS) {
      const m = re.exec(t);
      if (!m) continue;
      const category = m[2].trim().replace(/^(?:the|a)\s+/i, "");
      return { ref: cleanRef(m[1]), category: category.charAt(0).toUpperCase() + category.slice(1) };
    }
    return null;
  },
  async prepare(turn, args) {
    const custom = (await prisma.category.findMany({ where: { userId: turn.user.id }, select: { name: true } })).map((c) => c.name);
    const names = [...new Set([...PREDEFINED_CATEGORIES.map((c) => c.name), ...custom])];
    const wanted = String(args.category);
    const match = names.find((n) => n.toLowerCase() === wanted.toLowerCase()) ?? names.map((n) => ({ n, s: fuzzySimilarity(wanted, n) })).sort((a, b) => b.s - a.s).find((x) => x.s >= 0.75)?.n;
    if (!match) {
      return { out: { content: `You don't have a category called "${wanted}". Your categories: ${listJoin(names)}. You can add one in Settings.`, actions: names.slice(0, 5).map((n) => ({ label: n, text: `put ${args.ref || "it"} in the ${n} category` })), intent: "category_unknown" } };
    }
    return prepareTask(turn, "task_category", { ...args, category: match }, { includeCompleted: true });
  },
  async execute(turn, args) {
    const task = await taskOf(turn, args);
    if (!task) return gone;
    const updated = await edit(turn, task, { category: String(args.category) }, `category of "${task.title}"`);
    if (!updated) return gone;
    return { content: `"${updated.title}" is now in ${updated.category}.`, cards: [taskCard(updated, undefined, true)], actions: [UNDO_ACTION], intent: "task_category_updated" };
  },
};

/* ------------------------------------------------------------------ subtasks */

const SUB = "subtask|subtasks|sub task|sub tasks|sub-task|sub-tasks|steps|step|parts|checklist|سب ٹاسک|مراحل|مرحلے";

const SUBTASK_ADD: Array<{ re: RegExp; listFirst: boolean }> = [
  { re: /^(?:please\s+)?add\s+(?:a\s+|an\s+|the\s+|some\s+)?(?:sub-?\s?tasks?|steps?|parts?|checklist\s+items?)\s+(?:to|for|in|under)\s+(.+?)\s*[:\-–]\s*(.+)$/i, listFirst: false },
  { re: /^(?:please\s+)?add\s+(?:a\s+)?(?:sub-?\s?task|step)\s+["'“‘](.+?)["'”’]\s+(?:to|for|under|in)\s+(.+)$/i, listFirst: true },
  { re: /^(.+?)\s+(?:mein|me|main)\s+(?:sub-?\s?tasks?|steps?)\s+(?:add\s*karo|add\s*kar\s*do|daal\s*do|dal\s*do|banao|bana\s*do|likho)\s*[:\-–]?\s*(.+)$/i, listFirst: false },
  { re: /^(.+?)\s+میں\s+(?:سب ٹاسک|مرحلہ|مراحل)\s+(?:شامل کرو|ڈال دو|بنا دو)\s*[:،]?\s*(.+)$/, listFirst: false },
];

const subtaskAdd: Command = {
  name: "subtask_add",
  category: "tasks",
  summary: "Add subtasks to a task",
  examples: ["Add a subtask to the essay: write outline", "Add subtasks to the project: research, draft and review"],
  schema: taskRef.extend({ titles: z.array(z.string().min(1).max(120)).min(1).max(12) }),
  undoable: true,
  parse(text) {
    const t = text.trim().replace(/[.!]+$/, "");
    for (const p of SUBTASK_ADD) {
      const m = p.re.exec(t);
      if (!m) continue;
      const [list, ref] = p.listFirst ? [m[1], m[2]] : [m[2], m[1]];
      const titles = p.listFirst ? [list.charAt(0).toUpperCase() + list.slice(1)] : splitList(list);
      return titles.length ? { ref: cleanRef(ref), titles } : null;
    }
    return null;
  },
  prepare: (turn, args) => prepareTask(turn, "subtask_add", args),
  async execute(turn, args) {
    const parent = await taskOf(turn, args);
    if (!parent) return gone;
    const children: Task[] = [];
    for (const title of args.titles as string[]) {
      children.push(
        await createTask(turn.task, {
          title,
          priority: parent.priority,
          category: parent.category,
          source: TaskSource.ASSISTANT,
          parentTaskId: parent.id,
          dueDate: parent.dueDate,
          dueTime: parent.dueTime,
          taskType: parent.taskType === TaskType.FIXED ? TaskType.FLEXIBLE : parent.taskType,
          tags: Array.isArray(parent.tags) ? (parent.tags as string[]) : null,
          locationContext: parent.locationContext,
        }),
      );
    }
    focusOn(turn, parent.id);
    recordUndo(turn, { kind: "tasks", op: "create", taskIds: children.map((c) => c.id), label: `subtasks added to "${parent.title}"` });
    const total = (await listSubtasks(turn.user.id, parent.id)).length;
    return {
      content: `Added to "${parent.title}": ${listJoin(children.map((c) => `"${c.title}"`))}. It has ${total} subtask${total === 1 ? "" : "s"} now.`,
      cards: [{ type: "task_list", title: parent.title, tasks: children.map((c) => ({ ...c, isOverdue: false })) }],
      actions: [UNDO_ACTION, { label: "View task", payload: { type: "open_task", taskId: parent.id } }],
      intent: "subtasks_added",
    };
  },
};

const subtaskList: Command = {
  name: "subtask_list",
  category: "tasks",
  summary: "List a task's subtasks",
  examples: ["Show the subtasks of the essay", "essay ke subtasks dikhao"],
  schema: taskRef,
  undoable: false,
  parse(text) {
    const t = norm(text);
    if (!has(t, SUB) || !has(t, ASK) || has(t, "add|split|divide|break|complete|finish|mark|done|delete|remove")) return null;
    return { ref: refFrom(text, `${SUB}|${ASK}|${TASK_WORD}|of|for|in|on|all|has|have|got`) };
  },
  prepare: (turn, args) => prepareTask(turn, "subtask_list", args, { includeCompleted: true }),
  async execute(turn, args) {
    const parent = await taskOf(turn, args);
    if (!parent) return gone;
    focusOn(turn, parent.id);
    const subs = await listSubtasks(turn.user.id, parent.id);
    if (!subs.length) return { content: `"${parent.title}" has no subtasks.`, actions: [{ label: "Break it down", payload: { type: "break_down", taskId: parent.id } }], intent: "subtask_list" };
    const done = subs.filter((s) => s.status === TaskStatus.COMPLETED).length;
    const lines = subs.map((s, i) => `${i + 1}. ${s.title}${s.status === TaskStatus.COMPLETED ? " (done)" : ""}`);
    return { content: [`"${parent.title}": ${done}/${subs.length} done`, ...lines].join("\n"), intent: "subtask_list" };
  },
};

const ORDINAL: Record<string, number> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5, last: -1 };
const ordinal = (w: string | undefined) => (w ? (ORDINAL[w.toLowerCase()] ?? (Number(w.replace(/\D/g, "")) || undefined)) : undefined);

const SUBTASK_DONE: Array<{ re: RegExp; groups: { index?: number; index2?: number; name?: number; ref: number } }> = [
  { re: /^(?:please\s+)?(?:mark|complete|finish|tick\s+off|check\s+off|done\s+with)\s+(?:the\s+)?(?:(first|second|third|fourth|fifth|last|\d+(?:st|nd|rd|th)?)\s+)?(?:sub-?\s?task|step|part)\s*(\d+)?\s+(?:of|for|in|on)\s+(.+?)(?:\s+(?:as\s+)?(?:done|complete|completed|finished))?$/i, groups: { index: 1, index2: 2, ref: 3 } },
  { re: /^(?:please\s+)?(?:mark|complete|finish|tick\s+off|check\s+off)\s+(?:the\s+)?(.+?)\s+(?:sub-?\s?task|step)\s+(?:of|for|in|on)\s+(.+?)(?:\s+(?:as\s+)?(?:done|complete|completed|finished))?$/i, groups: { name: 1, ref: 2 } },
  { re: /^(?:the\s+)?(?:sub-?\s?task|step|part)\s+(\d+)\s+(?:of|for|on)\s+(.+?)\s+(?:is\s+)?(?:done|complete|finished)$/i, groups: { index: 1, ref: 2 } },
  { re: /^(.+?)\s+(?:ka|ki|ke)\s+(?:step|subtask|sub\s?task|part|hissa)\s+(\d+)\s+(?:ho\s+gaya|ho\s+gayi|ho\s+gya|done|mukammal|complete)(?:\s+.*)?$/i, groups: { index: 2, ref: 1 } },
];

const subtaskComplete: Command = {
  name: "subtask_complete",
  category: "tasks",
  summary: "Complete a subtask by number or name",
  examples: ["Mark step 2 of the essay as done", "essay ka step 1 ho gaya"],
  schema: taskRef.extend({ index: z.number().int().min(-1).max(50).optional(), name: z.string().max(120).optional(), subtaskId: z.string().uuid().optional() }),
  undoable: true,
  parse(text) {
    const t = text.trim().replace(/[.!]+$/, "");
    for (const { re, groups } of SUBTASK_DONE) {
      const m = re.exec(t);
      if (!m) continue;
      const index = ordinal(groups.index ? m[groups.index] : undefined) ?? ordinal(groups.index2 ? m[groups.index2] : undefined);
      const name = groups.name ? m[groups.name].trim() : undefined;
      if (index === undefined && !name) continue;
      return { ref: cleanRef(m[groups.ref]), ...(index !== undefined ? { index } : {}), ...(name ? { name: name.toLowerCase() } : {}) };
    }
    return null;
  },
  async prepare(turn, args) {
    const p = await prepareTask(turn, "subtask_complete", args, { includeCompleted: true });
    if ("out" in p) return p;
    const parent = await taskOf(turn, p.args);
    const subs = parent ? await listSubtasks(turn.user.id, parent.id) : [];
    if (!parent || !subs.length) return { out: { content: `"${parent?.title ?? args.ref}" has no subtasks.`, intent: "subtask_none" } };
    const index = typeof args.index === "number" ? (args.index === -1 ? subs.length : args.index) : null;
    const byName = typeof args.name === "string" ? subs.map((s) => ({ s, x: Math.max(fuzzySimilarity(String(args.name), s.title), s.title.toLowerCase().includes(String(args.name)) ? 0.9 : 0) })).sort((a, b) => b.x - a.x)[0] : null;
    const sub = index !== null ? subs[index - 1] : byName && byName.x >= 0.5 ? byName.s : null;
    if (!sub) return { out: { content: `"${parent.title}" has ${subs.length} subtask${subs.length === 1 ? "" : "s"}:\n${subs.map((s, i) => `${i + 1}. ${s.title}`).join("\n")}\nWhich one is done?`, intent: "subtask_which" } };
    return { args: { ...p.args, subtaskId: sub.id } };
  },
  async execute(turn, args) {
    const sub = await getTaskForUser(turn.user.id, String(args.subtaskId));
    if (!sub) return gone;
    const out = await handlePayload(turn, { type: "complete_task", taskId: sub.id });
    recordUndo(turn, { kind: "tasks", op: "edit", taskIds: [sub.id], before: snapshots([sub]), label: `"${sub.title}" done` });
    return { ...out, actions: [UNDO_ACTION, ...(out.actions ?? []).filter((a) => a.payload?.type !== "undo_task")] };
  },
};

/** Match order: subtasks before plain task phrasing ("mark step 2 of X done" is not "mark X done"). */
export const taskCommands: Command[] = [subtaskAdd, subtaskComplete, subtaskList, taskNotes, taskTags, taskCategory, taskReminderMode, taskReopen, taskStart];
