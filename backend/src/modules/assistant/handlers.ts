import { Priority, RoutineOccurrenceStatus, TaskStatus, TaskType, type Task } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { HttpError } from "../../lib/http.js";
import { addDaysYmd, dueDateFromYmd, formatClock, localParts, localYmd, relativeDayLabel, startOfLocalDay } from "../../lib/time.js";
import { formatDuration, fuzzySimilarity, listJoin, plural, truncate } from "../../lib/text.js";
import { logEvent } from "../events/eventService.js";
import { isMood, type Mood } from "../mood/moodService.js";
import { acceptRecommendation, dismissRecommendation } from "../patterns/recommendationService.js";
import { rescheduleOccurrence, updateOccurrence } from "../routines/routineService.js";
import { chunkPlan, dayPlan, loadScheduleContext, suggestSlot } from "../scheduling/schedulingService.js";
import {
  getTaskForUser,
  listActiveTasks,
  listSubtasks,
  restoreTask,
  serializeTask,
  softDeleteTask,
  splitTask,
  undoLastEdit,
  updateTask,
  type TaskChanges,
} from "../tasks/taskService.js";
import {
  askMoodConfirm,
  confirmMood,
  conversationalReply,
  focusOn,
  moodChips,
  proceedWithDraft,
  proceedWithRoutine,
  resolvePending,
  routineDraftFrom,
  startTaskDraft,
  storeInfo,
  taskCard,
  todayRoutinesText,
  dueLabel,
  type Out,
  type Turn,
} from "./dialogue.js";
import { resolveTaskRef } from "./draft.js";
import { RESPONSE_TEXT, STYLE_NAMES } from "../checkins/templates.js";
import { parseCheckinStyle } from "../checkins/style.js";
import { understand, type Understanding } from "./nlu.js";
import { proposeSubtasks } from "./responder.js";
import type { ActionPayload, QuickAction } from "./types.js";

/* ======================================================================== intents */

export async function handleIntent(turn: Turn, u: Understanding, text: string): Promise<Out> {
  switch (u.intent) {
    case "create_task": {
      if (u.mood?.explicit && !u.entities.date && !u.entities.time) return askMoodConfirm(turn, u.mood.mood, u.mood.confidence, text);
      const out = await proceedWithDraft(turn, startTaskDraft(turn, u, text), turn.source, { uncertainParse: u.source === "llm" && u.confidence < 0.75 });
      if (u.mood?.explicit && out.intent === "task_created") {
        out.content += `\nI also sense you're ${u.mood.mood}. Want a quick 2-minute breathing break before you start?`;
        out.actions = [{ label: "Breathing break", payload: { type: "breathing", minutes: 2 } }, ...(out.actions ?? [])];
        out.mood = u.mood.mood;
      }
      return out;
    }
    case "create_routine":
      return proceedWithRoutine(turn, routineDraftFrom(turn, u, text));
    case "update_task":
      return updateIntent(turn, u, text);
    case "complete_task":
      return completeIntent(turn, u);
    case "delete_task":
      return deleteIntent(turn, u);
    case "set_progress":
      return progressIntent(turn, u);
    case "query_progress":
      return queryProgress(turn, u);
    case "split_task":
      return splitIntent(turn, u);
    case "query_tasks":
      return queryTasks(turn, u, text);
    case "plan_day":
      return planDay(turn, u.entities.date?.ymd ?? null);
    case "read_back":
      return readBack(turn);
    case "undo":
      return undoIntent(turn);
    case "switch_context":
      return switchContext(turn, u.contextTarget ?? text);
    case "log_mood":
      if (u.mood) return askMoodConfirm(turn, u.mood.mood, u.mood.confidence, text);
      return { content: "How are you feeling right now?", actions: moodChips(), intent: "mood_ask" };
    case "support":
      return conversationalReply(turn, text, "support");
    case "provide_info":
      return storeInfo(turn, text);
    case "greeting":
      return greet(turn);
    case "thanks":
      return { content: "Anytime! I'm here whenever you need me.", intent: "thanks" };
    case "help":
      return help();
    case "set_checkin_style":
      return setCheckinStyle(turn, text);
    case "confirm":
    case "deny":
      return { content: u.intent === "confirm" ? "Great." : "Okay.", intent: u.intent };
    case "smalltalk":
      return conversationalReply(turn, text, "chat");
    case "unclear":
    default: {
      turn.state.pending = { kind: "clarify_intent", text };
      return {
        content: "I'm not sure what you'd like me to do. Is this a task, or are you just telling me?",
        actions: [
          { label: "Create a task", text: `Add a task: ${truncate(text, 60)}` },
          { label: "Add a routine", text: `Add a daily routine: ${truncate(text, 60)}` },
          { label: "Just telling you", text: "I'm just telling you" },
        ],
        intent: "unclear",
      };
    }
  }
}

const STYLE_CHIP_TEXT: Record<"FUNNY" | "SERIOUS" | "GENTLE", string> = {
  FUNNY: "Make check-ins funny",
  SERIOUS: "Make check-ins serious",
  GENTLE: "Make check-ins gentle",
};

/** FR-RN-004 §6: change the check-in style or turn check-ins off/on from chat. */
export async function setCheckinStyle(turn: Turn, text: string): Promise<Out> {
  const lang = turn.settings.language === "ur" ? "ur" : "en";
  const t = RESPONSE_TEXT[lang];
  const req = parseCheckinStyle(text) ?? { kind: "ask" as const };
  const others = (current: string) =>
    (["FUNNY", "SERIOUS", "GENTLE"] as const).filter((s) => s !== current).map((s) => ({ label: STYLE_NAMES[lang][s].replace(/^./, (c) => c.toUpperCase()), text: STYLE_CHIP_TEXT[s] }));
  if (req.kind === "ask") {
    return { content: t.STYLE_ASK, actions: (["FUNNY", "SERIOUS", "GENTLE"] as const).map((s) => ({ label: STYLE_NAMES[lang][s].replace(/^./, (c) => c.toUpperCase()), text: STYLE_CHIP_TEXT[s] })), intent: "checkin_style_ask" };
  }
  if (req.kind === "off" || req.kind === "on") {
    const checkinsEnabled = req.kind === "on";
    turn.settings = await prisma.userSettings.update({ where: { userId: turn.user.id }, data: { checkinsEnabled } });
    logEvent(turn.user.id, "CHECKIN_STYLE_CHANGED", null, { checkinsEnabled });
    return {
      content: checkinsEnabled ? t.CHECKINS_ON : t.CHECKINS_OFF,
      actions: checkinsEnabled ? others(turn.settings.checkinTone) : [{ label: lang === "ur" ? "دوبارہ آن کریں" : "Turn back on", text: "Turn check-ins back on" }],
      intent: checkinsEnabled ? "checkins_on" : "checkins_off",
    };
  }
  const wasOff = !turn.settings.checkinsEnabled;
  turn.settings = await prisma.userSettings.update({ where: { userId: turn.user.id }, data: { checkinTone: req.tone, checkinsEnabled: true } });
  logEvent(turn.user.id, "CHECKIN_STYLE_CHANGED", null, { checkinTone: req.tone, reenabled: wasOff });
  return { content: (wasOff ? t.STYLE_SET_AND_ON : t.STYLE_SET).replace("{style}", STYLE_NAMES[lang][req.tone]), actions: others(req.tone), intent: "checkin_style_set" };
}

function help(): Out {
  return {
    content:
      "I'm your personal assistant. I learn how you work and plan around it. You can talk to me naturally — for example:",
    actions: [
      { label: "Math assignment due Friday 3 PM", text: "Complete math assignment by Friday 3 PM" },
      { label: "Daily meditation at 6 AM", text: "Daily meditation at 6 AM for 10 minutes" },
      { label: "What do I have today?", text: "What do I have today?" },
      { label: "Plan my day", text: "Plan my day" },
      { label: "I'm feeling stressed", text: "I'm feeling stressed" },
      { label: "I'm 50% done with it", text: "I'm 50% done with it" },
    ],
    intent: "help",
  };
}

async function greet(turn: Turn): Promise<Out> {
  const { getBriefing } = await import("./briefing.js");
  const b = await getBriefing(turn.user, turn.settings, turn.now);
  const lines = [`${b.greeting}! ${b.headline}`];
  if (b.nextUp) lines.push(`Next up: "${b.nextUp.title}"${b.nextUp.dueAt ? ` (${dueLabel(b.nextUp as Task, turn)})` : ""}.`);
  const actions: QuickAction[] = [{ label: "Plan my day", payload: { type: "plan_day" } }];
  if (b.mood.checkinDue || !b.mood.latest) {
    lines.push("How are you feeling today?");
    actions.push(...moodChips().slice(0, 5));
  }
  return { content: lines.join("\n"), actions, intent: "greeting" };
}

async function chooseOrResolve(
  turn: Turn,
  u: Understanding,
  purpose: "update" | "complete" | "delete" | "progress" | "split" | "query_progress",
  data: Record<string, unknown> = {},
): Promise<{ task: Task } | { out: Out }> {
  const r = await resolveTaskRef(turn.user.id, u.targetRef, turn.state.focus, { includeCompleted: purpose === "update" || purpose === "query_progress" });
  if (r.task) return { task: r.task };
  if (r.candidates.length) {
    turn.state.pending = { kind: "choose_task", purpose, candidates: r.candidates.map((t) => t.id), data: { ...data, text: u.targetRef } };
    return {
      out: {
        content: "Which task do you mean?",
        actions: r.candidates.map((t, i) => ({ label: truncate(t.title, 32), text: `${i + 1}` })),
        cards: [{ type: "task_list", title: "Did you mean", tasks: r.candidates.map((t) => serializeTask(t)) }],
        intent: "choose_task",
      },
    };
  }
  return {
    out: {
      content: u.targetRef ? `I couldn't find a task matching "${u.targetRef}". Which one do you mean?` : "Which task do you mean?",
      actions: [{ label: "Show my tasks", text: "Show my tasks" }],
      intent: "not_found",
    },
  };
}

function changesFromUnderstanding(turn: Turn, task: Task, u: Understanding, text: string): { changes: TaskChanges; summary: string[] } {
  const e = u.entities;
  const changes: TaskChanges = {};
  const summary: string[] = [];
  if (e.date) {
    changes.dueDate = dueDateFromYmd(e.date.ymd, turn.tz);
    summary.push(`due ${relativeDayLabel(e.date.ymd, turn.todayYmd)}`);
  } else if (/\b(?:postpone|push(?:\s+back)?|delay)\b/i.test(text) && task.dueDate) {
    const ymd = addDaysYmd(localYmd(task.dueDate, turn.tz), 1);
    changes.dueDate = dueDateFromYmd(ymd, turn.tz);
    summary.push(`moved to ${relativeDayLabel(ymd, turn.todayYmd)}`);
  }
  if (e.time) {
    changes.dueTime = e.time;
    if (!changes.dueDate && !task.dueDate) changes.dueDate = dueDateFromYmd(turn.todayYmd, turn.tz);
    summary.push(`at ${e.time}`);
  }
  if (e.priority) {
    changes.priority = e.priority;
    summary.push(`now ${e.priority} priority`);
  }
  if (e.durationMinutes) {
    changes.durationMinutes = e.durationMinutes;
    summary.push(`takes ${formatDuration(e.durationMinutes)}`);
  }
  if (e.difficulty) changes.difficulty = e.difficulty;
  if (e.category && /\b(?:category|move it to|put it (?:in|under))\b/i.test(text)) {
    changes.category = e.category;
    summary.push(`category ${e.category}`);
  }
  const rename = text.match(/\b(?:rename|call)\s+(?:it|this|that|.+?)\s+(?:to|as)\s+["']?(.+?)["']?\s*$/i) ?? text.match(/\bchange (?:the )?(?:title|name) (?:of .+? )?to\s+["']?(.+?)["']?\s*$/i);
  if (rename) {
    changes.title = rename[1].charAt(0).toUpperCase() + rename[1].slice(1);
    summary.push(`renamed to "${changes.title}"`);
  }
  if (e.tags.length) {
    const existing = Array.isArray(task.tags) ? (task.tags as string[]) : [];
    changes.tags = [...new Set([...existing, ...e.tags])];
    summary.push(`tagged ${e.tags.map((t) => `#${t}`).join(" ")}`);
  }
  if (e.context) {
    changes.locationContext = e.context;
    summary.push(`context ${e.context}`);
  }
  return { changes, summary };
}

async function applyUpdate(turn: Turn, task: Task, changes: TaskChanges, summary: string[]): Promise<Out> {
  const updated = await updateTask(turn.task, task.id, changes);
  if (!updated) return { content: "I couldn't find that task anymore.", intent: "not_found" };
  focusOn(turn, updated.id);
  turn.state.pending = null;
  return {
    content: `Updated: ${updated.title} — ${listJoin(summary)}`,
    cards: [taskCard(updated, undefined, true)],
    actions: [{ label: "Undo", payload: { type: "undo_task", taskId: updated.id } }],
    intent: "task_updated",
  };
}

async function updateIntent(turn: Turn, u: Understanding, text: string): Promise<Out> {
  const found = await chooseOrResolve(turn, u, "update", { text });
  if ("out" in found) return found.out;
  const { changes, summary } = changesFromUnderstanding(turn, found.task, u, text);
  if (!summary.length) {
    focusOn(turn, found.task.id);
    return {
      content: `What should I change about "${found.task.title}"?`,
      actions: [
        { label: "Move to tomorrow", text: "move it to tomorrow" },
        { label: "Make it urgent", text: "make it urgent" },
        { label: "Change time", text: "change it to 5 PM" },
      ],
      intent: "update_ask",
    };
  }
  return applyUpdate(turn, found.task, changes, summary);
}

async function completeTask(turn: Turn, task: Task): Promise<Out> {
  const updated = await updateTask(turn.task, task.id, { status: TaskStatus.COMPLETED });
  if (!updated) return { content: "I couldn't find that task.", intent: "not_found" };
  focusOn(turn, updated.id);
  const lines = [`Nice work! "${updated.title}" is done.`];
  if (updated.parentTaskId) {
    const parent = await getTaskForUser(turn.user.id, updated.parentTaskId);
    if (parent?.status === TaskStatus.COMPLETED) lines.push(`"${parent.title}" is complete too — all parts finished!`);
    else if (parent) lines.push(`"${parent.title}" is now ${parent.progress}% complete.`);
  }
  const next = (await listActiveTasks(turn.user.id)).find((t) => t.id !== updated.id);
  if (next) lines.push(`Next up: "${next.title}"${next.dueAt ? ` (${dueLabel(next, turn)})` : ""}.`);
  return {
    content: lines.join("\n"),
    cards: [taskCard(updated, undefined, true)],
    actions: [{ label: "Undo", payload: { type: "undo_task", taskId: updated.id } }, ...(next ? [{ label: `Start "${truncate(next.title, 20)}"`, payload: { type: "start_task", taskId: next.id } as ActionPayload }] : [])],
    intent: "task_completed",
  };
}

async function completeIntent(turn: Turn, u: Understanding): Promise<Out> {
  const found = await chooseOrResolve(turn, u, "complete");
  if ("out" in found) return found.out;
  return completeTask(turn, found.task);
}

async function deleteIntent(turn: Turn, u: Understanding): Promise<Out> {
  const found = await chooseOrResolve(turn, u, "delete");
  if ("out" in found) return found.out;
  turn.state.pending = { kind: "confirm_delete", taskId: found.task.id, title: found.task.title };
  focusOn(turn, found.task.id);
  return {
    content: `Delete "${found.task.title}"? (You can undo within 1 day)`,
    actions: [
      { label: "Delete", payload: { type: "confirm_pending" }, style: "danger" },
      { label: "Cancel", payload: { type: "cancel_pending" } },
    ],
    intent: "confirm_delete",
  };
}

async function setProgress(turn: Turn, task: Task, progress: number): Promise<Out> {
  const updated = await updateTask(turn.task, task.id, { progress });
  if (!updated) return { content: "I couldn't find that task.", intent: "not_found" };
  focusOn(turn, updated.id);
  if (updated.status === TaskStatus.COMPLETED) return completeTask(turn, updated);
  const bar = "█".repeat(Math.round(progress / 10)).padEnd(10, "░");
  return {
    content: `${bar} ${progress}% — "${updated.title}" updated. ${progress >= 75 ? "Almost there!" : progress >= 50 ? "Halfway there!" : "Good start!"}`,
    cards: [{ type: "progress", task: serializeTask(updated) }],
    actions: [{ label: "Undo", payload: { type: "undo_task", taskId: updated.id } }],
    intent: "progress_updated",
  };
}

async function progressIntent(turn: Turn, u: Understanding): Promise<Out> {
  const found = await chooseOrResolve(turn, u, "progress", { progress: u.entities.progress });
  if ("out" in found) return found.out;
  return setProgress(turn, found.task, u.entities.progress ?? 0);
}

async function queryProgress(turn: Turn, u: Understanding): Promise<Out> {
  const found = await chooseOrResolve(turn, u, "query_progress");
  if ("out" in found) return found.out;
  focusOn(turn, found.task.id);
  const subtasks = await listSubtasks(turn.user.id, found.task.id);
  const done = subtasks.filter((s) => s.status === TaskStatus.COMPLETED).length;
  return {
    content: `"${found.task.title}" is ${found.task.progress}% complete${subtasks.length ? ` (${done}/${subtasks.length} parts done)` : ""}.`,
    cards: [{ type: "progress", task: serializeTask(found.task) }],
    intent: "query_progress",
  };
}

async function doSplit(turn: Turn, task: Task, parts: string[]): Promise<Out> {
  let names = parts;
  if (!names.length) {
    const count = task.durationMinutes && task.durationMinutes >= 240 ? 3 : task.durationMinutes && task.durationMinutes >= 120 ? 2 : 3;
    names = (await proposeSubtasks(task.title, count)) ?? Array.from({ length: count }, (_, i) => `Part ${i + 1}`);
  }
  const ctx = await loadScheduleContext(turn.user.id, turn.settings, 14);
  const share = task.durationMinutes ? Math.max(15, Math.round(task.durationMinutes / names.length)) : null;
  const planned: Array<{ title: string; durationMinutes: number | null; scheduledStart: Date | null; scheduledEnd: Date | null }> = [];
  let earliest = turn.now;
  for (const name of names) {
    let scheduledStart: Date | null = null;
    let scheduledEnd: Date | null = null;
    if (share) {
      const slot = suggestSlot(ctx, { durationMinutes: share, priority: task.priority, difficulty: task.difficulty, deadline: task.dueAt, earliest }, turn.now);
      if (slot) {
        scheduledStart = slot.start;
        scheduledEnd = slot.end;
        earliest = new Date(slot.end.getTime() + 15 * 60000);
        ctx.tasks.push({ ...task, id: `plan-${name}`, scheduledStart, scheduledEnd });
      }
    }
    planned.push({ title: name.length < 4 && /^\d/.test(name) ? `${task.title} — ${name}` : name, durationMinutes: share, scheduledStart, scheduledEnd });
  }
  const result = await splitTask(turn.task, task.id, planned);
  if (!result) return { content: "I couldn't split that task.", intent: "error" };
  focusOn(turn, task.id);
  return {
    content: `Split "${task.title}" into ${plural(result.children.length, "part")}${share ? ` (${formatDuration(share)} each)` : ""}. I'll mark it complete when all parts are done.`,
    cards: [{ type: "task_list", title: task.title, tasks: result.children.map((c) => serializeTask(c)) }],
    actions: [{ label: "View task", payload: { type: "open_task", taskId: task.id } }],
    intent: "task_split",
  };
}

async function splitIntent(turn: Turn, u: Understanding): Promise<Out> {
  const found = await chooseOrResolve(turn, u, "split", { parts: u.splitParts });
  if ("out" in found) return found.out;
  return doSplit(turn, found.task, u.splitParts);
}

async function queryTasks(turn: Turn, u: Understanding, text: string): Promise<Out> {
  if (/\b(?:when|what time|due|deadline|status)\b/i.test(text) && u.targetRef && !/\b(?:today|tomorrow|week|overdue|all|tasks?)\b/i.test(u.targetRef)) {
    const r = await resolveTaskRef(turn.user.id, u.targetRef, turn.state.focus, { includeCompleted: true });
    if (r.task) {
      focusOn(turn, r.task.id);
      const t = r.task;
      const state = t.status === TaskStatus.COMPLETED ? " — already done" : t.progress ? ` (${t.progress}% done)` : "";
      return {
        content: t.dueAt ? `"${t.title}" is due ${dueLabel(t, turn)}${state}.` : `"${t.title}" has no due date yet${state}. Want to set one?`,
        cards: [taskCard(t)],
        actions: t.status === TaskStatus.COMPLETED ? [] : [{ label: "Find time for it", payload: { type: "suggest_slot", taskId: t.id } }],
        intent: "query_task",
      };
    }
  }
  const all = await listActiveTasks(turn.user.id);
  const context = turn.settings.currentContext;
  const visible = all.filter((t) => !context || !t.locationContext || t.locationContext === context);
  let title = "Today";
  let list: Task[];
  if (/\boverdue|late|missed\b/i.test(text)) {
    title = "Overdue";
    list = visible.filter((t) => t.dueAt && t.dueAt < turn.now);
  } else if (/\b(?:this week|week)\b/i.test(text)) {
    title = "This week";
    const end = startOfLocalDay(addDaysYmd(turn.todayYmd, 7), turn.tz);
    list = visible.filter((t) => t.dueAt && t.dueAt < end);
  } else if (u.entities.date) {
    title = relativeDayLabel(u.entities.date.ymd, turn.todayYmd);
    list = visible.filter((t) => t.dueAt && localYmd(t.dueAt, turn.tz) === u.entities.date?.ymd);
  } else if (/\b(?:all|pending|everything|left|remaining)\b/i.test(text)) {
    title = "All pending";
    list = visible;
  } else {
    const end = startOfLocalDay(addDaysYmd(turn.todayYmd, 1), turn.tz);
    list = visible.filter((t) => (t.dueAt && t.dueAt < end) || (t.scheduledStart && t.scheduledStart < end));
  }
  list = list.slice(0, 12);
  focusOn(turn, ...list.slice(0, 3).map((t) => t.id).reverse());
  const routines = title.toLowerCase() === "today" ? await todayRoutinesText(turn) : "";
  const label = title.charAt(0).toUpperCase() + title.slice(1);
  const content = list.length
    ? `${label}: ${plural(list.length, "task")}${list.some((t) => t.dueAt && t.dueAt < turn.now) ? ` (${list.filter((t) => t.dueAt && t.dueAt < turn.now).length} overdue)` : ""}. ${routines}`.trim()
    : `Nothing ${title === "Overdue" ? "overdue" : `due ${title.toLowerCase()}`} ${routines}`.trim();
  return {
    content,
    cards: [{ type: "task_list", title: label, tasks: list.map((t) => serializeTask(t, turn.now)), emptyText: "Nothing here" }],
    actions: [{ label: "Plan my day", payload: { type: "plan_day" } }, { label: "Read them to me", text: "Read back my tasks" }],
    intent: "query_tasks",
  };
}

export async function planDay(turn: Turn, ymd: string | null): Promise<Out> {
  const target = ymd ?? turn.todayYmd;
  const plan = await dayPlan(turn.user.id, turn.settings, target, turn.now);
  const suggested = plan.blocks.filter((b) => b.kind === "suggested");
  const lines = [
    `Here's ${plan.label === "today" ? "today's" : `${plan.label}'s`} plan — ${formatDuration(plan.load.minutes)} of work against your ${formatDuration(plan.load.capacity)} capacity.`,
    ...plan.notes,
  ];
  if (suggested.length) lines.push(`I found time for ${plural(suggested.length, "task")}. Accept the slots you like.`);
  const actions: QuickAction[] = suggested.slice(0, 3).map((b) => {
    const p = localParts(b.start, turn.tz);
    return { label: `${truncate(b.title, 18)} @ ${formatClock(p.h, p.mi)}`, payload: { type: "accept_slot", taskId: b.id, start: b.start.toISOString(), end: b.end.toISOString() } };
  });
  return { content: lines.join("\n"), cards: [{ type: "plan", plan }], actions, intent: "plan_day" };
}

async function readBack(turn: Turn): Promise<Out> {
  const tasks = (await listActiveTasks(turn.user.id)).slice(0, 5);
  const routines = await todayRoutinesText(turn);
  const spoken = tasks.length
    ? `You have ${plural(tasks.length, "pending task")}. ${tasks.map((t, i) => `${i + 1}: ${t.title}${t.dueAt ? `, due ${dueLabel(t, turn)}` : ""}`).join(". ")}. ${routines}`
    : `You have no pending tasks. ${routines}`;
  return { content: spoken.trim(), speak: spoken.trim(), cards: [{ type: "task_list", title: "Pending", tasks: tasks.map((t) => serializeTask(t)) }], intent: "read_back" };
}

async function undoIntent(turn: Turn): Promise<Out> {
  for (const id of turn.state.focus) {
    const r = await undoTask(turn, id);
    if (r) return r;
  }
  return { content: "There's nothing recent I can undo.", intent: "undo_none" };
}

async function undoTask(turn: Turn, taskId: string): Promise<Out | null> {
  const task = await prisma.task.findFirst({ where: { id: taskId, userId: turn.user.id } });
  if (!task) return null;
  if (task.version === 1 && task.status !== TaskStatus.DELETED) {
    await softDeleteTask(turn.task, taskId);
    return { content: `↩ Removed "${task.title}".`, actions: [{ label: "Restore", payload: { type: "restore_task", taskId } }], intent: "undone" };
  }
  const restored = task.status === TaskStatus.DELETED ? await restoreTask(turn.task, taskId) : await undoLastEdit(turn.task, taskId);
  if (!restored) return null;
  return { content: `↩ Undone. "${restored.title}" is back to how it was.`, cards: [taskCard(restored)], intent: "undone" };
}

async function switchContext(turn: Turn, target: string): Promise<Out> {
  const contexts = Array.isArray(turn.settings.contexts) ? (turn.settings.contexts as string[]) : [];
  const best = contexts
    .map((c) => ({ c, s: fuzzySimilarity(target, c.replace(/^(at|in)\s+/i, "")) }))
    .sort((a, b) => b.s - a.s)[0];
  if (!best || best.s < 0.35) {
    return {
      content: `Which context? ${contexts.length ? contexts.join(", ") : "You haven't set up contexts yet."}`,
      actions: contexts.map((c) => ({ label: c, payload: { type: "set_context", context: c } })),
      intent: "switch_context",
    };
  }
  return setContext(turn, best.c);
}

async function setContext(turn: Turn, context: string): Promise<Out> {
  turn.settings = await prisma.userSettings.update({ where: { userId: turn.user.id }, data: { currentContext: context } });
  logEvent(turn.user.id, "CONTEXT_SWITCHED", null, { context });
  const routines = await todayRoutinesText(turn);
  return { content: `Switched to ${context}. I'll show the tasks and routines that fit here. ${routines}`.trim(), intent: "context_switched" };
}

/* ======================================================================== pending decisions owned here */

export async function resolveHandlerPending(turn: Turn, text: string, u: Understanding): Promise<Out | null> {
  const p = turn.state.pending;
  if (!p) return null;
  if (p.kind === "confirm_delete") {
    if (u.intent === "confirm" || /^delete/i.test(text)) return confirmDelete(turn, p.taskId);
    if (u.intent === "deny") {
      turn.state.pending = null;
      return { content: "Okay, kept it.", intent: "cancel" };
    }
    return null;
  }
  if (p.kind === "choose_task") {
    const tasks = await prisma.task.findMany({ where: { id: { in: p.candidates }, userId: turn.user.id } });
    const ordered = p.candidates.map((id) => tasks.find((t) => t.id === id)).filter((t): t is Task => Boolean(t));
    const n = Number(text.trim().replace(/[^\d]/g, ""));
    const chosen = n >= 1 && n <= ordered.length ? ordered[n - 1] : ordered.map((t) => ({ t, s: fuzzySimilarity(text, t.title) })).sort((a, b) => b.s - a.s)[0]?.s >= 0.45 ? ordered.map((t) => ({ t, s: fuzzySimilarity(text, t.title) })).sort((a, b) => b.s - a.s)[0].t : null;
    if (!chosen) return null;
    turn.state.pending = null;
    focusOn(turn, chosen.id);
    const original = String(p.data.text ?? "");
    switch (p.purpose) {
      case "complete":
        return completeTask(turn, chosen);
      case "delete":
        turn.state.pending = { kind: "confirm_delete", taskId: chosen.id, title: chosen.title };
        return {
          content: `Delete "${chosen.title}"? (You can undo within 1 day)`,
          actions: [{ label: "Delete", payload: { type: "confirm_pending" }, style: "danger" }, { label: "Cancel", payload: { type: "cancel_pending" } }],
          intent: "confirm_delete",
        };
      case "progress":
        return setProgress(turn, chosen, Number(p.data.progress ?? 0));
      case "split":
        return doSplit(turn, chosen, Array.isArray(p.data.parts) ? (p.data.parts as string[]) : []);
      case "query_progress":
        return { content: `"${chosen.title}" is ${chosen.progress}% complete.`, cards: [{ type: "progress", task: serializeTask(chosen) }], intent: "query_progress" };
      case "update":
      default: {
        const again = await understand(String(p.data.text ?? original), { now: turn.now, tz: turn.tz, history: [], allowLlm: false });
        const { changes, summary } = changesFromUnderstanding(turn, chosen, again, String(p.data.text ?? ""));
        if (!summary.length) return { content: `What should I change about "${chosen.title}"?`, intent: "update_ask" };
        return applyUpdate(turn, chosen, changes, summary);
      }
    }
  }
  return null;
}

async function confirmDelete(turn: Turn, taskId: string): Promise<Out> {
  turn.state.pending = null;
  const deleted = await softDeleteTask(turn.task, taskId);
  if (!deleted) return { content: "That task is already gone.", intent: "not_found" };
  return {
    content: `Deleted "${deleted.title}". You can undo this for 24 hours.`,
    actions: [{ label: "Undo", payload: { type: "restore_task", taskId } }],
    intent: "task_deleted",
  };
}

/* ======================================================================== one-tap actions */

export async function handlePayload(turn: Turn, payload: ActionPayload): Promise<Out> {
  switch (payload.type) {
    case "confirm_pending": {
      const p = turn.state.pending;
      if (!p) return { content: "There's nothing waiting for confirmation.", intent: "noop" };
      if (p.kind === "task_review") return proceedWithDraft(turn, p.draft, p.source, { clarified: true, reviewed: true });
      if (p.kind === "confirm_delete") return confirmDelete(turn, p.taskId);
      if (p.kind === "mood_confirm" && isMood(p.mood)) return confirmMood(turn, p.mood, p.confidence);
      if (p.kind === "typo") {
        const u = await understand("yes", { now: turn.now, tz: turn.tz, history: [], allowLlm: false });
        return (await resolvePending(turn, "yes", u)) ?? { content: "Okay.", intent: "noop" };
      }
      return { content: "Okay.", intent: "noop" };
    }
    case "cancel_pending":
      turn.state.pending = null;
      return { content: "Okay, cancelled.", intent: "cancel" };
    case "complete_task": {
      const task = await getTaskForUser(turn.user.id, payload.taskId);
      return task ? completeTask(turn, task) : { content: "That task no longer exists.", intent: "not_found" };
    }
    case "undo_task":
      return (await undoTask(turn, payload.taskId)) ?? { content: "That change can't be undone anymore.", intent: "undo_none" };
    case "restore_task": {
      const restored = await restoreTask(turn.task, payload.taskId);
      return restored
        ? { content: `↩ Restored "${restored.title}".`, cards: [taskCard(restored)], intent: "task_restored" }
        : { content: "It's been more than 24 hours, so that task can't be restored.", intent: "restore_failed" };
    }
    case "accept_slot": {
      const task = await getTaskForUser(turn.user.id, payload.taskId);
      if (!task) return { content: "That task no longer exists.", intent: "not_found" };
      const start = new Date(payload.start);
      const end = new Date(payload.end);
      const updated = await updateTask(turn.task, task.id, { scheduledStart: start, scheduledEnd: end });
      const p = localParts(start, turn.tz);
      return { content: `Scheduled "${task.title}" ${relativeDayLabel(localYmd(start, turn.tz), turn.todayYmd)} at ${formatClock(p.h, p.mi)}.`, cards: updated ? [taskCard(updated)] : [], intent: "slot_accepted" };
    }
    case "suggest_slot": {
      const task = await getTaskForUser(turn.user.id, payload.taskId);
      if (!task) return { content: "That task no longer exists.", intent: "not_found" };
      const ctx = await loadScheduleContext(turn.user.id, turn.settings, 14);
      const slot = suggestSlot(ctx, { durationMinutes: task.durationMinutes ?? 60, priority: task.priority, difficulty: task.difficulty, deadline: task.dueAt, excludeTaskId: task.id }, turn.now);
      if (!slot) return { content: `I couldn't find a free ${formatDuration(task.durationMinutes ?? 60)} slot before the deadline. Want to extend capacity or move something?`, intent: "no_slot" };
      return {
        content: `How about ${slot.reason}?`,
        actions: [
          { label: "Book it", payload: { type: "accept_slot", taskId: task.id, start: slot.start.toISOString(), end: slot.end.toISOString() }, style: "primary" },
          { label: "Not now", payload: { type: "cancel_pending" } },
        ],
        intent: "slot_suggested",
      };
    }
    case "chunk_task":
      return chunkTask(turn, payload.taskId);
    case "break_down": {
      const task = await getTaskForUser(turn.user.id, payload.taskId);
      return task ? doSplit(turn, task, []) : { content: "That task no longer exists.", intent: "not_found" };
    }
    case "postpone_task":
      return postpone(turn, [payload.taskId], payload.days);
    case "postpone_nonurgent": {
      const ids = payload.taskIds?.length
        ? payload.taskIds
        : (await listActiveTasks(turn.user.id))
            .filter((t) => t.priority !== Priority.URGENT && t.taskType !== TaskType.FIXED && t.dueAt && t.dueAt < startOfLocalDay(addDaysYmd(turn.todayYmd, 2), turn.tz))
            .map((t) => t.id);
      return postpone(turn, ids, 1);
    }
    case "log_mood":
      if (!isMood(payload.mood)) return { content: "How are you feeling?", actions: moodChips(), intent: "mood_ask" };
      return confirmMood(turn, payload.mood as Mood, 1, payload.score);
    case "overdue_action":
      return overdueAction(turn, payload.taskId, payload.choice);
    case "routine_occurrence": {
      try {
        const o = await updateOccurrence(turn.user.id, payload.occurrenceId, payload.status as RoutineOccurrenceStatus, { confirmMandatory: payload.confirmMandatory });
        if (!o) return { content: "That routine occurrence wasn't found.", intent: "not_found" };
        return { content: payload.status === "COMPLETED" ? `${o.routine.title} done. Keep the streak going!` : `Skipped ${o.routine.title} for now.`, intent: "routine_updated" };
      } catch (error) {
        if (error instanceof HttpError && error.code === "MANDATORY_CONFIRMATION_REQUIRED") {
          return {
            content: error.message,
            actions: [
              { label: "Skip anyway", payload: { ...payload, confirmMandatory: true }, style: "danger" },
              { label: "Keep it", payload: { type: "cancel_pending" } },
            ],
            intent: "mandatory_confirm",
          };
        }
        throw error;
      }
    }
    case "reschedule_occurrence": {
      const o = await rescheduleOccurrence(turn.user.id, turn.tz, payload.occurrenceId, payload.ymd, payload.time);
      return o ? { content: `${o.routine.title} moved to ${relativeDayLabel(payload.ymd, turn.todayYmd)}${payload.time ? ` at ${payload.time}` : ""}.`, intent: "routine_rescheduled" } : { content: "That routine occurrence wasn't found.", intent: "not_found" };
    }
    case "accept_recommendation":
      return { content: `${await acceptRecommendation(turn.user, turn.settings, payload.id)}`, intent: "recommendation_accepted" };
    case "dismiss_recommendation":
      await dismissRecommendation(turn.user, turn.settings, payload.id);
      return { content: "Okay, I won't suggest that again.", intent: "recommendation_dismissed" };
    case "show_top3": {
      const top = (await listActiveTasks(turn.user.id))
        .sort((a, b) => ({ URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 })[a.priority] - ({ URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 })[b.priority] || (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity))
        .slice(0, 3);
      focusOn(turn, ...top.map((t) => t.id).reverse());
      return {
        content: top.length ? "Here are your top 3. Ignore the rest for now — one thing at a time." : "You have nothing urgent. Take a breather.",
        cards: [{ type: "task_list", title: "Top 3", tasks: top.map((t) => serializeTask(t)) }],
        actions: top[0] ? [{ label: `Break down #1`, payload: { type: "break_down", taskId: top[0].id } }, { label: `Start #1`, payload: { type: "start_task", taskId: top[0].id } }] : [],
        intent: "top3",
      };
    }
    case "plan_day":
      return planDay(turn, payload.ymd ?? null);
    case "start_task": {
      const task = await getTaskForUser(turn.user.id, payload.taskId);
      if (!task) return { content: "That task no longer exists.", intent: "not_found" };
      const minutes = task.durationMinutes ? Math.max(15, Math.round(task.durationMinutes * (1 - task.progress / 100))) : 45;
      const start = turn.now;
      const end = new Date(start.getTime() + Math.min(minutes, 90) * 60000);
      const updated = await updateTask(turn.task, task.id, {
        status: TaskStatus.IN_PROGRESS,
        progress: Math.max(task.progress, 5),
        scheduledStart: start,
        scheduledEnd: end,
      });
      focusOn(turn, task.id);
      const p = localParts(end, turn.tz);
      return { content: `▶ Focus on "${task.title}" until ${formatClock(p.h, p.mi)}. Tell me how far you get!`, cards: updated ? [taskCard(updated)] : [], intent: "task_started" };
    }
    case "set_context":
      return setContext(turn, payload.context);
    case "breathing":
      return { content: "Let's breathe together: in for 4, hold for 4, out for 6.", cards: [{ type: "breathing", minutes: payload.minutes }], intent: "breathing" };
    case "open_task":
    case "navigate":
      return { content: "Opening…", intent: "navigate" };
    default:
      return { content: "Okay.", intent: "noop" };
  }
}

async function postpone(turn: Turn, ids: string[], days: number): Promise<Out> {
  const moved: Task[] = [];
  for (const id of ids.slice(0, 15)) {
    const t = await getTaskForUser(turn.user.id, id);
    if (!t) continue;
    const shift = days * 86400000;
    const updated = await updateTask(turn.task, id, {
      dueDate: t.dueDate ? new Date(t.dueDate.getTime() + shift) : dueDateFromYmd(addDaysYmd(turn.todayYmd, days), turn.tz),
      scheduledStart: t.scheduledStart ? new Date(t.scheduledStart.getTime() + shift) : null,
      scheduledEnd: t.scheduledEnd ? new Date(t.scheduledEnd.getTime() + shift) : null,
    });
    if (updated) {
      moved.push(updated);
      logEvent(turn.user.id, "TASK_POSTPONED", id, { days });
    }
  }
  if (!moved.length) return { content: "There was nothing to postpone. You're all clear.", intent: "postponed" };
  return {
    content: `Moved ${plural(moved.length, "task")} ${days === 1 ? "to tomorrow" : `by ${days} days`}. Take care of yourself first.`,
    cards: [{ type: "task_list", title: "Postponed", tasks: moved.map((t) => serializeTask(t)) }],
    intent: "postponed",
  };
}

async function chunkTask(turn: Turn, taskId: string): Promise<Out> {
  const task = await getTaskForUser(turn.user.id, taskId);
  if (!task) return { content: "That task no longer exists.", intent: "not_found" };
  const total = Math.max(45, Math.round((task.durationMinutes ?? 90) * (1 - task.progress / 100)));
  const ctx = await loadScheduleContext(turn.user.id, turn.settings, 7);
  const span = total + Math.floor((total - 1) / 45) * 15;
  const start =
    task.scheduledStart && task.scheduledStart > turn.now
      ? task.scheduledStart
      : (suggestSlot(ctx, { durationMinutes: span, priority: task.priority, deadline: task.dueAt, excludeTaskId: task.id }, turn.now)?.start ?? new Date(turn.now.getTime() + 15 * 60000));
  const plan = chunkPlan(start, total);
  const work = plan.filter((b) => b.kind === "work");
  const result = await splitTask(
    turn.task,
    task.id,
    work.map((b, i) => ({ title: `${task.title} (${i + 1}/${work.length})`, durationMinutes: Math.round((b.end.getTime() - b.start.getTime()) / 60000), scheduledStart: b.start, scheduledEnd: b.end })),
  );
  if (!result) return { content: "I couldn't break that down.", intent: "error" };
  const fmt = (d: Date) => {
    const p = localParts(d, turn.tz);
    return formatClock(p.h, p.mi);
  };
  const outline = plan.map((b) => `${fmt(b.start)}–${fmt(b.end)} ${b.kind === "work" ? "focus" : "break"}`).join(" · ");
  return {
    content: `Broken into ${plural(work.length, "45-minute chunk")} with 15-minute breaks:\n${outline}`,
    cards: [{ type: "task_list", title: task.title, tasks: result.children.map((c) => serializeTask(c)) }],
    intent: "task_chunked",
  };
}

async function overdueAction(turn: Turn, taskId: string, choice: "complete_now" | "couldnt" | "extension" | "plan"): Promise<Out> {
  const task = await getTaskForUser(turn.user.id, taskId);
  if (!task) return { content: "That task no longer exists.", intent: "not_found" };
  focusOn(turn, task.id);
  if (choice === "couldnt") {
    const updated = await updateTask(turn.task, task.id, { status: TaskStatus.SKIPPED, archived: true });
    return { content: `Okay — "${task.title}" is archived. It happens; what matters is what's next.`, cards: updated ? [taskCard(updated)] : [], intent: "overdue_archived" };
  }
  if (choice === "extension") {
    return {
      content: `Asking for an extension is up to you — a short, honest message usually works. Want a reminder to send it?`,
      actions: [{ label: "Remind me today 5 PM", text: `Remind me to ask for an extension on ${task.title} today at 5 PM`, style: "primary" }],
      intent: "overdue_extension",
    };
  }
  const remaining = Math.max(15, Math.round((task.durationMinutes ?? 60) * (1 - task.progress / 100)));
  const ctx = await loadScheduleContext(turn.user.id, turn.settings, 7);
  const slot = suggestSlot(ctx, { durationMinutes: remaining, priority: Priority.HIGH, excludeTaskId: task.id, horizonDays: choice === "complete_now" ? 0 : 5 }, turn.now);
  if (!slot) return { content: `I couldn't find a free ${formatDuration(remaining)} slot ${choice === "complete_now" ? "today" : "this week"}.`, intent: "no_slot" };
  if (choice === "complete_now") {
    const updated = await updateTask(turn.task, task.id, { status: TaskStatus.IN_PROGRESS, scheduledStart: slot.start, scheduledEnd: slot.end });
    return { content: `▶ Let's do it: ${slot.reason}. You've got this!`, cards: updated ? [taskCard(updated)] : [], intent: "overdue_now" };
  }
  return {
    content: `Plan to finish the remaining ${formatDuration(remaining)}: ${slot.reason}?`,
    actions: [
      { label: "Book it", payload: { type: "accept_slot", taskId: task.id, start: slot.start.toISOString(), end: slot.end.toISOString() }, style: "primary" },
      { label: "Another time", payload: { type: "suggest_slot", taskId: task.id } },
    ],
    intent: "overdue_plan",
  };
}

