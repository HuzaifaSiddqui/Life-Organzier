import {
  ConversationRole,
  Prisma,
  RoutineFrequency,
  RoutinePriority,
  TaskSource,
  TaskStatus,
  TaskType,
  type Conversation,
  type Task,
  type User,
  type UserSettings,
} from "@prisma/client";
import { prisma } from "../../config/db.js";
import type { ChatMessage } from "../../ai/llm.js";
import { getAi } from "../../ai/llm.js";
import {
  addDaysYmd,
  dueDateFromYmd,
  formatClock,
  instantLabel,
  localParts,
  localYmd,
  parseClock,
  relativeDayLabel,
  zonedTimeToUtc,
} from "../../lib/time.js";
import { formatDuration, fuzzySimilarity, listJoin, plural, truncate } from "../../lib/text.js";
import { addMessage, getOrCreateConversation, readState, recentChat, saveState } from "../conversations/conversationService.js";
import { logEvent } from "../events/eventService.js";
import { buildAssistantContext } from "../memory/contextBuilder.js";
import {
  extractAndStoreMemories,
  maybeSummarizeConversation,
  messageEmbedding,
  rememberFact,
  retrieveMemories,
  ruleBasedMemories,
} from "../memory/memoryService.js";
import {
  crisisPayload,
  detectCrisis,
  isMood,
  latestMood,
  logMood,
  MOOD_EMOJI,
  recommendForMood,
  STRESS,
  type Mood,
} from "../mood/moodService.js";
import { getPatterns } from "../patterns/patternService.js";
import { createRoutine, mandatoryConflicts, occurrencesForDay } from "../routines/routineService.js";
import { autoScheduleSlot, dayLoad, loadScheduleContext, movableTasksOn, suggestSlot } from "../scheduling/schedulingService.js";
import {
  createTask,
  getTaskForUser,
  listActiveTasks,
  serializeTask,
  updateTask,
  type TaskContext,
} from "../tasks/taskService.js";
import {
  applyLearnedCorrections,
  AUTO_CREATE_CLARITY,
  clarificationQuestion,
  clarityOf,
  detectTypo,
  draftFromEntities,
  draftSummary,
  draftToCreateInput,
  fillDraft,
  VERY_LOW_CLARITY,
} from "./draft.js";
import { extractEntities, isHabitLike, isVagueTitle, type ExtractOptions } from "./entities.js";
import { understand, type Understanding } from "./nlu.js";
import { generateReply } from "./responder.js";
import { handleIntent, handlePayload, resolveHandlerPending } from "./handlers.js";
import type { ActionPayload, AssistantReply, Card, DialogueState, QuickAction, RoutineDraft, TaskDraft } from "./types.js";

export type Channel = "APP" | "VOICE" | "WHATSAPP";

export type Turn = {
  user: User;
  settings: UserSettings;
  tz: string;
  now: Date;
  todayYmd: string;
  channel: Channel;
  source: "CHAT" | "VOICE" | "WHATSAPP";
  conversation: Conversation;
  state: DialogueState;
  history: ChatMessage[];
  task: TaskContext;
  learned: string[];
  memoriesUsed: number;
};

export type Out = {
  content: string;
  cards?: Card[];
  actions?: QuickAction[];
  speak?: string;
  intent?: string;
  mood?: string | null;
};

export function isPro(settings: UserSettings): boolean {
  return settings.tier === "PRO";
}

export function extractOpts(turn: Turn): ExtractOptions {
  return {
    now: turn.now,
    tz: turn.tz,
    contexts: Array.isArray(turn.settings.contexts) ? (turn.settings.contexts as string[]) : [],
  };
}

export function focusOn(turn: Turn, ...ids: Array<string | null | undefined>): void {
  const clean = ids.filter((x): x is string => Boolean(x));
  turn.state.focus = [...clean, ...turn.state.focus.filter((id) => !clean.includes(id))].slice(0, 8);
}

export function taskCard(task: Task, note?: string, undoable = false): Card {
  return { type: "task", task: serializeTask(task), note, undoable };
}

export function dueLabel(task: Task, turn: Turn): string {
  if (task.dueAt) {
    const day = relativeDayLabel(localYmd(task.dueAt, turn.tz), turn.todayYmd);
    return task.dueTime ? `${day} ${task.dueTime}` : day;
  }
  return "no due date";
}

/* ======================================================================== entry point */

export async function handleAssistantMessage(input: {
  user: User;
  settings: UserSettings;
  deviceId: string | null;
  text?: string | null;
  payload?: ActionPayload | null;
  label?: string | null;
  conversationId?: string | null;
  channel: Channel;
}): Promise<AssistantReply> {
  const now = new Date();
  const tz = input.settings.timezone;
  const conversation = await getOrCreateConversation(input.user.id, input.channel, input.conversationId);
  const turn: Turn = {
    user: input.user,
    settings: input.settings,
    tz,
    now,
    todayYmd: localYmd(now, tz),
    channel: input.channel,
    source: input.channel === "WHATSAPP" ? "WHATSAPP" : input.channel === "VOICE" ? "VOICE" : "CHAT",
    conversation,
    state: readState(conversation),
    history: await recentChat(conversation.id, 8),
    task: { userId: input.user.id, tz, deviceId: input.deviceId },
    learned: [],
    memoriesUsed: 0,
  };

  const text = input.text?.trim() ?? "";
  const userContent = text || input.label?.trim() || "";
  const userMessage = userContent
    ? await addMessage({
        conversationId: conversation.id,
        userId: input.user.id,
        role: ConversationRole.USER,
        content: userContent,
        metadata: input.payload ? ({ payload: input.payload } as Prisma.InputJsonValue) : null,
      })
    : null;

  let out: Out;
  try {
    out = input.payload ? await handlePayload(turn, input.payload) : await handleText(turn, text);
  } catch (error) {
    console.error("Assistant turn failed", error);
    out = { content: "Sorry — something went wrong on my side. Could you try that again?", intent: "error" };
  }

  turn.state.turn += 1;
  await saveState(conversation.id, turn.state);
  const meta = {
    cards: out.cards ?? [],
    actions: out.actions ?? [],
    intent: out.intent,
    speak: out.speak ?? out.content,
    mood: out.mood ?? null,
    memoriesUsed: turn.memoriesUsed,
    learned: turn.learned,
  };
  const assistantMessage = await addMessage({
    conversationId: conversation.id,
    userId: input.user.id,
    role: ConversationRole.ASSISTANT,
    content: out.content,
    metadata: meta as unknown as Prisma.InputJsonValue,
  });
  if (!conversation.title && userContent) {
    await prisma.conversation.update({ where: { id: conversation.id }, data: { title: truncate(userContent, 60) } });
  }

  // Learning happens after the reply so it never adds latency.
  void learnInBackground(turn, userMessage?.id ?? null, text, out.intent ?? "");

  return {
    conversationId: conversation.id,
    userMessage: userMessage ? { id: userMessage.id, content: userMessage.content, createdAt: userMessage.createdAt.toISOString() } : null,
    message: { id: assistantMessage.id, role: "ASSISTANT", content: out.content, createdAt: assistantMessage.createdAt.toISOString(), ...meta },
  };
}

/** Only conversational turns can carry durable personal facts; commands never do. */
const LLM_EXTRACTION_INTENTS = new Set(["support", "smalltalk", "unclear", "mood_logged", "mood_confirm", "chat", "chat_fallback"]);

async function learnInBackground(turn: Turn, messageId: string | null, text: string, intent: string): Promise<void> {
  try {
    if (messageId && text) {
      const embedding = await messageEmbedding(text);
      await prisma.conversationMessage.update({ where: { id: messageId }, data: { embedding } });
    }
    if (text && text.length >= 12 && intent !== "provide_info") {
      await extractAndStoreMemories(turn.user.id, text, {
        allowLlm: LLM_EXTRACTION_INTENTS.has(intent),
        source: `${turn.channel.toLowerCase()}:${turn.conversation.id}`,
      });
    }
    await maybeSummarizeConversation(turn.conversation.id, turn.user.id);
  } catch (error) {
    console.warn("Background learning failed", error instanceof Error ? error.message : error);
  }
}

/* ======================================================================== text turns */

const STRONG_SWITCH = new Set(["query_tasks", "plan_day", "complete_task", "delete_task", "update_task", "set_progress", "query_progress", "split_task", "undo", "greeting", "help", "switch_context", "read_back"]);

/** Text turns. The crisis check is the first step, ahead of open questions, NLU and every handler. */
export async function handleText(turn: Turn, text: string): Promise<Out> {
  if (!text) return { content: "I'm listening — what would you like to do?", intent: "empty" };

  if (detectCrisis(text)) {
    turn.state.pending = null;
    const crisis = crisisPayload(turn.settings.language);
    return {
      content: crisis.message,
      cards: [{ type: "resources", resources: crisis.resources }],
      actions: [{ label: turn.settings.language === "ur" ? "آج کے غیر ضروری کام ہٹا دیں" : "Clear today's non-urgent tasks", payload: { type: "postpone_nonurgent" } }],
      intent: "crisis",
    };
  }

  const memoryHint = turn.history.length ? null : (await retrieveMemories(turn.user.id, text, { k: 2 })).map((m) => m.content).join("; ") || null;
  const u = await understand(text, {
    ...extractOpts(turn),
    history: turn.history,
    pendingHint: pendingHint(turn.state),
    memoryHint,
    allowLlm: true,
  });

  if (turn.state.pending) {
    const resolved = await resolvePending(turn, text, u);
    if (resolved) return resolved;
  }
  return handleIntent(turn, u, text);
}

const SWITCH_INTENTS = new Set([...STRONG_SWITCH, "support", "thanks"]);
const QUESTIONISH = /\?\s*$|^(?:what|when|where|why|how|who|which|can|could|should|would|is|are|do|does|did)\b/i;

function isTopicSwitch(u: Understanding, text: string): boolean {
  if (SWITCH_INTENTS.has(u.intent)) return true;
  if (u.intent === "smalltalk" && u.confidence >= 0.85) return true;
  if (u.intent === "log_mood" && u.mood?.explicit) return true;
  const e = u.entities;
  const hasSlotContent = Boolean(e.date || e.time || e.durationMinutes || e.priority || e.frequency);
  if ((u.intent === "smalltalk" || u.intent === "provide_info") && !hasSlotContent) return true;
  return QUESTIONISH.test(text.trim()) && !hasSlotContent;
}

function pendingHint(state: DialogueState): string | null {
  const p = state.pending;
  if (!p) return null;
  switch (p.kind) {
    case "task_draft":
      return `details (${p.awaiting.join(", ")}) for the task "${p.draft.title ?? "new task"}"`;
    case "routine_draft":
      return `details (${p.awaiting.join(", ")}) for the routine "${p.draft.title ?? "new routine"}"`;
    case "mood_confirm":
      return `confirmation that the user feels ${p.mood}`;
    default:
      return `an answer about ${p.kind.replace(/_/g, " ")}`;
  }
}

/**
 * Working memory: interprets the message as an answer to the open question when it fits;
 * returns null when the user moved on to something else (the pending question is dropped).
 */
export async function resolvePending(turn: Turn, text: string, u: Understanding): Promise<Out | null> {
  const p = turn.state.pending;
  if (!p) return null;
  const yes = u.intent === "confirm";
  const no = u.intent === "deny";

  // "break it down" while a task is still being drafted → create it, then split it.
  if (p.kind === "task_draft" && u.intent === "split_task" && !u.targetRef && p.draft.title) {
    const created = await proceedWithDraft(
      turn,
      { ...p.draft, allowNoTime: true, allowNoDuration: true, allowNoDate: true, dueTime: p.draft.dueTime ?? (p.draft.dueYmd ? "11:59 PM" : null) },
      p.source,
      { clarified: true, reviewed: true },
    );
    if (created.intent !== "task_created") return created;
    const split = await handleIntent(turn, u, text);
    const firstLine = created.content.split(/\r?\n/)[0];
    return { ...split, content: `${firstLine}\n${split.content}` };
  }

  // The user changed the subject: never force their message into the open question.
  if (isTopicSwitch(u, text) && p.kind !== "choose_task" && p.kind !== "mood_confirm") {
    turn.state.pending = null;
    return null;
  }

  switch (p.kind) {
    case "task_draft": {
      // "Morning workout" → "every day at 7am": the draft turns out to be a routine.
      if (u.entities.frequency) {
        turn.state.pending = null;
        return proceedWithRoutine(turn, {
          ...routineDraftFrom(turn, u, text),
          title: p.draft.title ?? (u.title || null),
          category: p.draft.category ?? u.entities.category,
        });
      }
      const { draft, filled } = fillDraft(p.draft, p.awaiting, text, extractOpts(turn));
      if (filled) {
        if (p.awaiting.includes("title") && isVagueTitle(draft.title) && isVagueTitle(p.draft.title)) {
          turn.state.pending = { kind: "clarify_intent", text };
          return {
            content: "I'm still not sure what you'd like to do. Do you want to:",
            actions: [
              { label: "Create a task", text: "I want to create a task" },
              { label: "Set a reminder", text: "Set a reminder" },
              { label: "Add a routine", text: "Add a routine" },
              { label: "Never mind", payload: { type: "cancel_pending" } },
            ],
            intent: "clarify_intent",
          };
        }
        return proceedWithDraft(turn, draft, p.source, { clarified: true, confidence: u.confidence });
      }
      if (no) return cancelPending(turn, "No problem — I won't add it.");
      break;
    }
    case "task_review": {
      if (yes) return proceedWithDraft(turn, p.draft, p.source, { clarified: true, confidence: 90, reviewed: true });
      if (no) return cancelPending(turn, "Okay, discarded.");
      const { draft, filled } = fillDraft(p.draft, ["date", "time", "duration"], text, extractOpts(turn));
      if (filled) return proceedWithDraft(turn, draft, p.source, { clarified: true, confidence: 90 });
      break;
    }
    case "routine_draft": {
      const next = fillRoutineDraft(p.draft, text, turn);
      if (next.changed) return proceedWithRoutine(turn, next.draft);
      if (no) return cancelPending(turn, "Okay, I won't create that routine.");
      break;
    }
    case "mood_confirm": {
      if (yes) return confirmMood(turn, p.mood as Mood, p.confidence);
      const corrected = (["stressed", "anxious", "happy", "tired", "motivated", "sad", "overwhelmed", "focused", "calm"] as Mood[]).find((m) =>
        new RegExp(`\\b${m}\\b`, "i").test(text),
      );
      if (corrected) return confirmMood(turn, corrected, 1);
      if (no) return cancelPending(turn, "Thanks for clarifying. How are you feeling, then?", moodChips());
      break;
    }
    case "confirm_delete":
    case "confirm_update":
    case "choose_task":
    case "clarify_intent":
    case "prereq":
    case "past_date":
    case "typo":
    case "capacity":
    case "conflict": {
      const r = await resolveChoicePending(turn, text, u);
      if (r) return r;
      break;
    }
  }
  if (STRONG_SWITCH.has(u.intent) || (u.intent === "create_task" && u.confidence >= 0.85) || u.intent === "create_routine" || u.intent === "log_mood") {
    turn.state.pending = null;
    return null;
  }
  // Still waiting: re-ask briefly instead of losing the thread.
  return reask(turn);
}

function cancelPending(turn: Turn, content: string, actions?: QuickAction[]): Out {
  turn.state.pending = null;
  return { content, actions, intent: "cancel" };
}

function reask(turn: Turn): Out | null {
  const p = turn.state.pending;
  if (!p) return null;
  if ((p.kind === "task_draft" || p.kind === "routine_draft") && (p.reasks ?? 0) >= 1) {
    // Asked twice already — the user has moved on; don't nag.
    turn.state.pending = null;
    return null;
  }
  if (p.kind === "task_draft" || p.kind === "routine_draft") p.reasks = (p.reasks ?? 0) + 1;
  if (p.kind === "task_draft") {
    return {
      content: `Just to finish "${p.draft.title ?? "this task"}": ${clarificationQuestion(p.draft, p.awaiting)}`,
      actions: [...slotChips(p.awaiting), { label: "Cancel", payload: { type: "cancel_pending" } }],
      intent: "clarify",
    };
  }
  if (p.kind === "routine_draft") return routineQuestion(turn, p.draft, p.awaiting);
  turn.state.pending = null;
  return null;
}

export function moodChips(): QuickAction[] {
  return (["happy", "motivated", "calm", "tired", "stressed", "anxious", "sad", "overwhelmed"] as Mood[]).map((m) => ({
    label: m.charAt(0).toUpperCase() + m.slice(1),
    payload: { type: "log_mood", mood: m },
  }));
}

function slotChips(awaiting: string[]): QuickAction[] {
  if (awaiting.includes("date")) return ["Today", "Tomorrow", "This Friday", "Next week", "No deadline"].map((l) => ({ label: l, text: l }));
  if (awaiting.includes("time")) return ["9 AM", "12 PM", "3 PM", "6 PM", "9 PM", "End of day"].map((l) => ({ label: l, text: l }));
  if (awaiting.includes("duration")) return ["30 min", "1 hour", "2 hours", "3 hours", "Not sure"].map((l) => ({ label: l, text: l }));
  return [];
}

/* ======================================================================== task creation pipeline */

export function startTaskDraft(turn: Turn, u: Understanding, text: string): TaskDraft {
  return draftFromEntities(text, u.title, u.entities, turn.todayYmd);
}

function pastDateCheck(turn: Turn, draft: TaskDraft, source: "CHAT" | "VOICE" | "WHATSAPP"): Out | null {
  if (draft.dueYmd && draft.dueYmd < turn.todayYmd) {
    turn.state.pending = { kind: "past_date", draft, source };
    return {
      content: `${relativeDayLabel(draft.dueYmd, turn.todayYmd) === "yesterday" ? "Yesterday" : `${draft.dueYmd}`} is in the past. Did you mean today or another date?`,
      actions: [
        { label: "Today", text: "today" },
        { label: "Tomorrow", text: "tomorrow" },
        { label: "Another date", text: "another date" },
      ],
      intent: "past_date",
    };
  }
  if (draft.dueYmd === turn.todayYmd && draft.dueTime) {
    const c = parseClock(draft.dueTime);
    const p = localParts(turn.now, turn.tz);
    if (c && c.h * 60 + c.m < p.h * 60 + p.mi - 5) {
      turn.state.pending = { kind: "past_date", draft, source };
      return {
        content: `${draft.dueTime} today has already passed. Do you mean tomorrow, or a later time today?`,
        actions: [{ label: "Tomorrow", text: "tomorrow" }, { label: "Later today", text: "another time today" }],
        intent: "past_date",
      };
    }
  }

  return null;
}

/**
 * Validates and enriches a draft through every check required by the FRD, asking at most one
 * question per turn, then creates and auto-schedules the task.
 */
export async function proceedWithDraft(
  turn: Turn,
  draftIn: TaskDraft,
  source: "CHAT" | "VOICE" | "WHATSAPP",
  opts: { clarified?: boolean; confidence?: number; reviewed?: boolean; uncertainParse?: boolean } = {},
): Promise<Out> {
  let draft = { ...draftIn };
  if (draft.title) draft.title = await applyLearnedCorrections(turn.user.id, draft.title);
  const { clarity, missing } = clarityOf(draft);

  // FR-EH-003: very low clarity → offer intents instead of guessing.
  if (clarity < VERY_LOW_CLARITY && !opts.clarified) {
    turn.state.pending = { kind: "clarify_intent", text: draft.title ?? "" };
    return {
      content: "I'm not sure what you mean. Do you want to:",
      actions: [
        { label: "Create a task", text: `Create a task: ${draft.title ?? ""}`.trim() },
        { label: "Set a reminder", text: `Remind me: ${draft.title ?? ""}`.trim() },
        { label: "Add a routine", text: `Add a daily routine: ${draft.title ?? ""}`.trim() },
        { label: "Something else", payload: { type: "cancel_pending" } },
      ],
      cards: [{ type: "draft", draft, clarity, missing }],
      intent: "clarify_intent",
    };
  }

  const past = pastDateCheck(turn, draft, source);
  if (past) return past;

  if (missing.length) {
    turn.state.pending = { kind: "task_draft", draft, awaiting: missing, source, clarity };
    const priorityHint = !draft.priorityExplicit && missing.includes("date") && missing.includes("duration") ? " How urgent is it?" : "";
    return {
      content: `${clarificationQuestion(draft, missing)}${priorityHint}`,
      cards: [{ type: "draft", draft, clarity, missing }],
      actions: [
        ...slotChips(missing),
        ...(priorityHint ? (["Urgent", "High", "Low"] as const).map((p) => ({ label: p, text: `${p} priority` })) : []),
        { label: "Cancel", payload: { type: "cancel_pending" } },
      ],
      intent: "clarify",
    };
  }

  // Typo suggestion (FR-EH-003 §4) — asked once per draft.
  if (draft.title && !opts.reviewed && !draft.prereqChecked) {
    const corrected = await detectTypo(turn.user.id, draft.title);
    if (corrected && corrected !== draft.title) {
      turn.state.pending = { kind: "typo", draft, source, corrected };
      return {
        content: `Did you mean "${corrected}"?`,
        actions: [
          { label: `Yes, "${truncate(corrected, 30)}"`, payload: { type: "confirm_pending" }, style: "primary" },
          { label: "No, keep it", text: "no" },
        ],
        intent: "typo",
      };
    }
  }

  // Prerequisite check from syllabus knowledge (FR-DP-004 §3).
  if (!draft.prereqChecked && draft.title) {
    const prereq = await findPrerequisite(turn, draft.title);
    if (prereq) {
      turn.state.pending = { kind: "prereq", draft, course: prereq.course, prereq: prereq.prereq, source };
      return {
        content: `I see you're studying ${prereq.course} topics. Have you completed ${prereq.prereq}?`,
        actions: [
          { label: "Yes", text: "yes" },
          { label: "No", text: "no" },
        ],
        intent: "prereq",
      };
    }
  }

  // Low-confidence parse → show extraction for review (FR-TM-001 §1: clarity < 95%).
  const confidence = Math.min(clarity, opts.uncertainParse && !opts.clarified ? 85 : 100);
  if (confidence < AUTO_CREATE_CLARITY && !opts.reviewed) {
    turn.state.pending = { kind: "task_review", draft, source, clarity: confidence };
    return {
      content: `Here's what I understood: ${draftSummary(draft, turn.todayYmd)}. Shall I add it?`,
      cards: [{ type: "draft", draft, clarity: confidence, missing: [] }],
      actions: [
        { label: "Add it", payload: { type: "confirm_pending" }, style: "primary" },
        { label: "Edit details", payload: { type: "navigate", screen: "AddTask" } },
        { label: "Cancel", payload: { type: "cancel_pending" } },
      ],
      intent: "review",
    };
  }

  const ctx = await loadScheduleContext(turn.user.id, turn.settings, 14);

  // Overload prevention (FR-TM-006 §4).
  if (draft.dueYmd && draft.durationMinutes && !draft.overrideCapacity && draft.taskType !== TaskType.FIXED) {
    const load = dayLoad(ctx, draft.dueYmd);
    if (load.minutes + draft.durationMinutes > load.capacity) {
      const movable = movableTasksOn(ctx, draft.dueYmd).slice(0, 3);
      turn.state.pending = { kind: "capacity", draft, source, ymd: draft.dueYmd };
      const day = relativeDayLabel(draft.dueYmd, turn.todayYmd);
      return {
        content: `${day.charAt(0).toUpperCase()}${day.slice(1)} is at capacity — ${formatDuration(load.minutes)} already planned of your ${formatDuration(load.capacity)}. ${movable.length ? `I could move ${listJoin(movable.map((t) => `"${t.title}"`))}. ` : ""}What would you like to do?`,
        cards: movable.length ? [{ type: "task_list", title: "Flexible tasks you could move", tasks: movable.map((t) => serializeTask(t)) }] : [],
        actions: [
          { label: "Pick another day", text: "pick another day", style: "primary" },
          ...(movable.length ? [{ label: "Move flexible tasks", text: "move flexible tasks" }] : []),
          { label: "Add anyway", text: "add anyway" },
        ],
        intent: "capacity",
      };
    }
  }

  // Mandatory routine conflict (FR-RM-002 §3).
  if (draft.dueYmd && draft.dueTime && !draft.overrideConflict && (draft.taskType === TaskType.FIXED || draft.durationMinutes)) {
    const c = parseClock(draft.dueTime);
    if (c) {
      const start = zonedTimeToUtc(draft.dueYmd, c.h, c.m, turn.tz);
      {
        const blockStart = draft.taskType === TaskType.FIXED ? start : new Date(start.getTime() - (draft.durationMinutes ?? 60) * 60000);
        const blockEnd = draft.taskType === TaskType.FIXED ? new Date(start.getTime() + (draft.durationMinutes ?? 60) * 60000) : start;
        const conflicts = await mandatoryConflicts(turn.user.id, turn.tz, blockStart, blockEnd);
        if (conflicts.length) {
          const r = conflicts[0].routine;
          turn.state.pending = { kind: "conflict", draft, source, routine: r.title };
          return {
            content: `Your mandatory routine "${r.title}" (${r.dueTime}) conflicts with "${draft.title}". Which should take priority?`,
            actions: [
              { label: `Keep ${truncate(r.title, 18)}, move task`, text: "keep the routine", style: "primary" },
              { label: "Do the task anyway", text: "do the task anyway" },
            ],
            intent: "conflict",
          };
        }
      }
    }
  }

  // Auto-schedule duration work into a free slot (FR-TM-006); DEADLINE tasks only if it ends before the deadline.
  let scheduleNote = "";
  let noSlot = false;
  if (draft.durationMinutes && !draft.scheduledStart) {
    const dueClock = parseClock(draft.dueTime);
    const deadline = draft.dueYmd
      ? dueClock
        ? zonedTimeToUtc(draft.dueYmd, dueClock.h, dueClock.m, turn.tz)
        : dueDateFromYmd(addDaysYmd(draft.dueYmd, 1), turn.tz)
      : null;
    const { slot, attempted } = autoScheduleSlot(ctx, draft, deadline, turn.now);
    if (slot) {
      draft.scheduledStart = slot.start.toISOString();
      draft.scheduledEnd = slot.end.toISOString();
      scheduleNote = `Scheduled ${slot.reason}.`;
    } else if (attempted && draft.taskType === TaskType.DEADLINE) {
      noSlot = true;
      scheduleNote = `I couldn't find a free ${formatDuration(draft.durationMinutes)} slot before the deadline. Want to extend capacity or move something?`;
    }
  }

  const taskSource = source === "WHATSAPP" ? TaskSource.WHATSAPP : source === "VOICE" ? TaskSource.VOICE : TaskSource.CHAT;
  const task = await createTask(turn.task, draftToCreateInput(draft, turn.tz, taskSource, confidence));
  turn.state.pending = null;
  focusOn(turn, task.id);

  const lines = [`Added: ${draftSummary(draft, turn.todayYmd)}`];
  if (scheduleNote) lines.push(scheduleNote);
  const actions: QuickAction[] = [
    { label: "Undo", payload: { type: "undo_task", taskId: task.id } },
    { label: "View task", payload: { type: "open_task", taskId: task.id } },
  ];
  if (draft.scheduledStart) actions.splice(1, 0, { label: "Change", payload: { type: "open_task", taskId: task.id } });
  if ((!draft.durationMinutes || noSlot) && task.taskType !== TaskType.FIXED) actions.push({ label: "Find time for it", payload: { type: "suggest_slot", taskId: task.id } });

  // Stress-aware follow-up (FR-MH-003 §2).
  const mood = await latestMood(turn.user.id, 8);
  if (mood && STRESS.has(mood.mood) && (draft.durationMinutes ?? 0) >= 120) {
    lines.push(`You mentioned feeling ${mood.mood} — this is a big one. Want to break it into 45-minute chunks with breaks?`);
    actions.unshift({ label: "Break into chunks", payload: { type: "chunk_task", taskId: task.id }, style: "primary" });
    actions.push({ label: "Move to tomorrow", payload: { type: "postpone_task", taskId: task.id, days: 1 } });
  }
  return { content: lines.join("\n"), cards: [taskCard(task, undefined, true)], actions, intent: "task_created" };
}

async function findPrerequisite(turn: Turn, title: string): Promise<{ course: string; prereq: string } | null> {
  const courses = await prisma.memoryItem.findMany({ where: { userId: turn.user.id, kind: "COURSE" } });
  if (!courses.length) return null;
  for (const c of courses) {
    const meta = (c.metadata ?? {}) as { code?: string; name?: string; topics?: string[]; prerequisites?: string[] };
    if (!meta.prerequisites?.length) continue;
    const key = `${meta.code ?? meta.name}`;
    if (turn.state.prereqAsked.includes(key)) continue;
    const terms = [meta.code, meta.name, ...(meta.topics ?? [])].filter((x): x is string => Boolean(x));
    const hit = terms.some((t) => fuzzySimilarity(t, title) >= 0.6 || title.toLowerCase().includes(t.toLowerCase()));
    if (!hit) continue;
    const prereq = meta.prerequisites[0];
    const known = await prisma.memoryItem.findFirst({
      where: { userId: turn.user.id, kind: "FACT", content: { contains: prereq, mode: "insensitive" } },
    });
    if (known) continue;
    turn.state.prereqAsked.push(key);
    return { course: meta.code ?? meta.name ?? "this course", prereq };
  }
  return null;
}

async function resolveChoicePending(turn: Turn, text: string, u: Understanding): Promise<Out | null> {
  const p = turn.state.pending;
  if (!p) return null;
  const yes = u.intent === "confirm";
  const no = u.intent === "deny";
  const lower = text.toLowerCase();

  if (p.kind === "typo") {
    if (yes) {
      const from = (p.draft.title ?? "").split(/\s+/);
      const to = p.corrected.split(/\s+/);
      for (let i = 0; i < Math.min(from.length, to.length); i += 1) {
        if (from[i].toLowerCase() !== to[i].toLowerCase()) {
          await rememberFact(turn.user.id, {
            kind: "CORRECTION",
            content: `User spells "${from[i]}" as "${to[i]}"`,
            importance: 0.3,
            metadata: { from: from[i].toLowerCase().replace(/[^a-z]/g, ""), to: to[i] },
          });
        }
      }
      return proceedWithDraft(turn, { ...p.draft, title: p.corrected, prereqChecked: p.draft.prereqChecked }, p.source, { clarified: true, reviewed: true });
    }
    if (no) return proceedWithDraft(turn, p.draft, p.source, { clarified: true, reviewed: true });
    return null;
  }
  if (p.kind === "past_date") {
    const { draft, filled } = fillDraft(p.draft, ["date", "time"], text, extractOpts(turn));
    if (filled && (draft.dueYmd ?? "") >= turn.todayYmd) return proceedWithDraft(turn, draft, p.source, { clarified: true });
    if (/another (date|day)|different/.test(lower)) {
      turn.state.pending = { kind: "task_draft", draft: { ...p.draft, dueYmd: null, dateText: null }, awaiting: ["date"], source: p.source, clarity: 60 };
      return { content: "Which date works?", actions: slotChips(["date"]), intent: "clarify" };
    }
    if (/another time|later today/.test(lower)) {
      turn.state.pending = { kind: "task_draft", draft: { ...p.draft, dueYmd: turn.todayYmd, dueTime: null }, awaiting: ["time"], source: p.source, clarity: 60 };
      return { content: "What time today?", actions: slotChips(["time"]), intent: "clarify" };
    }
    return null;
  }
  if (p.kind === "prereq") {
    const draft = { ...p.draft, prereqChecked: true };
    if (yes) {
      await rememberFact(turn.user.id, { kind: "FACT", content: `User has completed ${p.prereq}`, importance: 0.7 });
      return proceedWithDraft(turn, draft, p.source, { clarified: true });
    }
    if (no) {
      const out = await proceedWithDraft(turn, draft, p.source, { clarified: true });
      if (out.intent === "task_created") {
        out.content += `\nSince ${p.prereq} is a prerequisite, want to add some ${p.prereq} review first?`;
        out.actions = [{ label: `Add ${p.prereq} review`, text: `Add a task to review ${p.prereq} basics this week for 2 hours`, style: "primary" }, ...(out.actions ?? [])];
      }
      return out;
    }
    return null;
  }
  if (p.kind === "capacity") {
    if (/add anyway|anyway|yes/.test(lower) || yes) return proceedWithDraft(turn, { ...p.draft, overrideCapacity: true }, p.source, { clarified: true, reviewed: true });
    if (/another day|different day|pick/.test(lower)) {
      turn.state.pending = { kind: "task_draft", draft: { ...p.draft, dueYmd: null, dateText: null }, awaiting: ["date"], source: p.source, clarity: 60 };
      return { content: "Which day instead?", actions: slotChips(["date"]), intent: "clarify" };
    }
    if (/move/.test(lower)) {
      const ctx = await loadScheduleContext(turn.user.id, turn.settings, 7);
      const movable = movableTasksOn(ctx, p.ymd).slice(0, 3);
      const moved: string[] = [];
      for (const t of movable) {
        await updateTask(turn.task, t.id, {
          dueDate: t.dueDate ? new Date(t.dueDate.getTime() + 86400000) : null,
          scheduledStart: t.scheduledStart ? new Date(t.scheduledStart.getTime() + 86400000) : null,
          scheduledEnd: t.scheduledEnd ? new Date(t.scheduledEnd.getTime() + 86400000) : null,
        });
        logEvent(turn.user.id, "TASK_POSTPONED", t.id, { reason: "capacity" });
        moved.push(t.title);
      }
      const out = await proceedWithDraft(turn, { ...p.draft, overrideCapacity: true }, p.source, { clarified: true, reviewed: true });
      if (moved.length) out.content = `Moved ${listJoin(moved.map((m) => `"${m}"`))} to the next day.\n${out.content}`;
      return out;
    }
    if (no) return cancelPending(turn, "Okay, I didn't add it.");
    return null;
  }
  if (p.kind === "conflict") {
    if (/keep|routine|move/.test(lower)) {
      const ctx = await loadScheduleContext(turn.user.id, turn.settings, 7);
      const slot = suggestSlot(ctx, { durationMinutes: p.draft.durationMinutes ?? 60, priority: p.draft.priority, preferredYmd: p.draft.dueYmd }, turn.now);
      const draft: TaskDraft = { ...p.draft, overrideConflict: true };
      if (slot) {
        const lp = localParts(slot.start, turn.tz);
        draft.dueYmd = slot.ymd;
        draft.dueTime = formatClock(lp.h, lp.mi);
        draft.scheduledStart = slot.start.toISOString();
        draft.scheduledEnd = slot.end.toISOString();
      }
      return proceedWithDraft(turn, draft, p.source, { clarified: true, reviewed: true });
    }
    if (/anyway|task|yes/.test(lower) || yes) return proceedWithDraft(turn, { ...p.draft, overrideConflict: true }, p.source, { clarified: true, reviewed: true });
    return null;
  }
  if (p.kind === "clarify_intent") {
    turn.state.pending = null;
    return null;
  }
  // confirm_delete / confirm_update / choose_task are handled by the intent handlers module.
  return resolveHandlerPending(turn, text, u);
}

/* ======================================================================== routines */

const TIME_LOCKED_RE = /\b(morning|wake|prayer|pray|namaz|fajr|breakfast|lunch|dinner|meditat\w*|jog\w*|walk|run|medicine|medication|pills?|sleep|bed)\b/i;
const FLEXIBLE_RE = /\b(checkup|check-up|bill|payment|dentist|doctor|appointment|clean\w*|laundry|groceries|shopping|haircut)\b/i;

export function routineDraftFrom(turn: Turn, u: Understanding, text: string): RoutineDraft {
  const e = u.entities;
  const partOfDay = !e.timeExplicit ? text.match(/\b(morning|afternoon|evening|night)\b/i)?.[1] : undefined;
  let title = u.title || null;
  if (title && partOfDay && !new RegExp(partOfDay, "i").test(title)) title = `${partOfDay.charAt(0).toUpperCase()}${partOfDay.slice(1).toLowerCase()} ${title.toLowerCase()}`;
  // Habits without an explicit frequency ("Morning workout") default to daily; vague times are asked.
  const frequency = e.frequency ?? (isHabitLike(text) ? RoutineFrequency.DAILY : null);
  return {
    title,
    frequency,
    daysOfWeek: e.daysOfWeek,
    dayOfMonth: e.dayOfMonth,
    dueTime: e.timeExplicit ? e.time : null,
    flexibleTime: e.flexibleTime,
    durationMinutes: e.durationMinutes,
    priority: e.routinePriority ?? RoutinePriority.NORMAL,
    category: e.category,
    timeLocked: Boolean(e.time) && !FLEXIBLE_RE.test(text) && (TIME_LOCKED_RE.test(text) || e.routinePriority === RoutinePriority.MANDATORY || isHabitLike(text)),
    context: e.context,
  };
}

function fillRoutineDraft(draft: RoutineDraft, text: string, turn: Turn): { draft: RoutineDraft; changed: boolean } {
  const e = extractEntities(text, extractOpts(turn));
  const next = { ...draft };
  let changed = false;
  if (e.frequency) {
    next.frequency = e.frequency;
    next.daysOfWeek = e.daysOfWeek;
    next.dayOfMonth = e.dayOfMonth;
    changed = true;
  } else if (!next.frequency && e.date) {
    next.frequency = RoutineFrequency.WEEKLY;
    next.daysOfWeek = [new Date(`${e.date.ymd}T12:00:00Z`).getUTCDay()];
    changed = true;
  }
  if (e.time) {
    next.dueTime = e.time;
    next.timeLocked = !FLEXIBLE_RE.test(next.title ?? "");
    changed = true;
  }
  if (e.flexibleTime || /\bflexible\b/i.test(text)) {
    next.flexibleTime = true;
    next.timeLocked = false;
    changed = true;
  }
  if (e.durationMinutes) {
    next.durationMinutes = e.durationMinutes;
    changed = true;
  }
  if (e.routinePriority) {
    next.priority = e.routinePriority;
    changed = true;
  }
  if (!next.title) {
    const t = text.trim();
    if (t.length >= 3 && !e.frequency && !e.time) {
      next.title = t.charAt(0).toUpperCase() + t.slice(1);
      changed = true;
    }
  }
  return { draft: next, changed };
}

function routineQuestion(turn: Turn, draft: RoutineDraft, awaiting: Array<"title" | "frequency" | "time">): Out {
  turn.state.pending = { kind: "routine_draft", draft, awaiting };
  if (awaiting.includes("title")) return { content: "What's the routine?", intent: "clarify" };
  if (awaiting.includes("frequency")) {
    return {
      content: `How often should "${draft.title}" happen?`,
      actions: ["Daily", "Weekdays", "Weekly", "Monthly"].map((l) => ({ label: l, text: l })),
      intent: "clarify",
    };
  }
  return {
    content: `What time for "${draft.title}"? Or is it flexible?`,
    actions: [...["6 AM", "7 AM", "9 AM", "6 PM", "9 PM"].map((l) => ({ label: l, text: l })), { label: "Flexible", text: "flexible" }],
    intent: "clarify",
  };
}

export async function proceedWithRoutine(turn: Turn, draft: RoutineDraft): Promise<Out> {
  const awaiting: Array<"title" | "frequency" | "time"> = [];
  if (!draft.title) awaiting.push("title");
  if (!draft.frequency) awaiting.push("frequency");
  if (!draft.dueTime && !draft.flexibleTime) awaiting.push("time");
  if (awaiting.length) return routineQuestion(turn, draft, awaiting);

  let learnedNote = "";
  if (!draft.dueTime && draft.category) {
    const patterns = await getPatterns(turn.user.id, turn.tz);
    const hours = (patterns.find((p) => p.key === "category_hours")?.value.categories ?? []) as Array<{ category: string; hour: number }>;
    const match = hours.find((h) => h.category === draft.category);
    if (match) learnedNote = `You usually do ${draft.category} things around ${formatClock(match.hour, 0)} — want me to set it then?`;
  }
  const routine = await createRoutine(turn.user.id, turn.tz, {
    title: draft.title as string,
    frequency: draft.frequency as RoutineFrequency,
    daysOfWeek: draft.daysOfWeek,
    dayOfMonth: draft.dayOfMonth,
    dueTime: draft.dueTime,
    durationMinutes: draft.durationMinutes,
    category: draft.category,
    priority: draft.priority,
    timeLocked: draft.timeLocked,
    locationContext: draft.context,
  });
  turn.state.pending = null;
  const freq =
    draft.frequency === RoutineFrequency.DAILY
      ? "Daily"
      : draft.frequency === RoutineFrequency.MONTHLY
        ? `Monthly (day ${draft.dayOfMonth})`
        : `Every ${listJoin((draft.daysOfWeek ?? []).map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]))}`;
  const details = [draft.dueTime ?? "flexible time", draft.durationMinutes ? formatDuration(draft.durationMinutes) : null].filter(Boolean).join(", ");
  const lines = [`Created: ${freq} ${draft.title} (${details})`];
  if (draft.priority === RoutinePriority.MANDATORY) lines.push("Mandatory routine — I'll schedule around it and ask before skipping.");
  if (draft.timeLocked) lines.push("It's time-locked: if missed, I won't move it — the next one will be ready.");
  if (learnedNote) lines.push(learnedNote);
  const actions: QuickAction[] = [{ label: "View routines", payload: { type: "navigate", screen: "Routines" } }];
  if (draft.priority !== RoutinePriority.MANDATORY) actions.push({ label: "Make it mandatory", text: `Make ${draft.title} mandatory` });
  return { content: lines.join("\n"), cards: [{ type: "routine", routine: routine as unknown as Record<string, unknown> }], actions, intent: "routine_created" };
}

/* ======================================================================== mood */

export function askMoodConfirm(turn: Turn, mood: Mood, confidence: number, text: string): Out {
  turn.state.pending = { kind: "mood_confirm", mood, confidence, text };
  const question =
    mood === "anxious" || mood === "stressed"
      ? `Sounds like you're ${mood}. Is that right?`
      : mood === "happy" || mood === "motivated" || mood === "focused" || mood === "calm"
        ? `Love that — you're feeling ${mood}. Right?`
        : `I sense you're ${mood}. Correct?`;
  const others = (["stressed", "tired", "anxious", "happy", "overwhelmed", "sad"] as Mood[]).filter((m) => m !== mood).slice(0, 3);
  return {
    content: question,
    actions: [{ label: "Yes", text: "yes", style: "primary" }, ...others.map((m) => ({ label: `I'm ${m}`, payload: { type: "log_mood", mood: m } as ActionPayload }))],
    intent: "mood_confirm",
    mood,
  };
}

export async function confirmMood(turn: Turn, mood: Mood, confidence: number, score?: number): Promise<Out> {
  turn.state.pending = null;
  await logMood(turn.user.id, turn.tz, { mood, score: score ?? null, source: turn.source === "CHAT" ? "CHAT" : turn.source, confidence: Math.round(confidence * 100) });
  const [tasks, context] = await Promise.all([listActiveTasks(turn.user.id), buildAssistantContext({ user: turn.user, settings: turn.settings, conversation: turn.conversation, query: `feeling ${mood}`, budgetChars: 1100 })]);
  turn.memoriesUsed = context.memories.length;
  const rec = recommendForMood(mood, tasks, context.copingMemories);
  let content = rec.message;
  if (isPro(turn.settings) || STRESS.has(mood) || mood === "sad") {
    const llm = await generateReply({
      mode: "mood",
      contextBlock: context.block,
      history: turn.history,
      userText: `I'm feeling ${mood}.`,
      language: turn.settings.language,
      instruction: `The assistant will also show these suggestions: ${rec.primary?.label ?? ""}; ${rec.suggestions.map((s) => s.label).join("; ")}. Write a short caring reply that leads into them. Do not list them. Do not ask how they feel — they just told you.`,
    });
    if (llm) content = llm;
  }
  const actions: QuickAction[] = [];
  if (rec.primary) actions.push({ label: rec.primary.label, payload: suggestionPayload(rec.primary.action), style: "primary" });
  if (STRESS.has(mood) || mood === "sad") actions.push({ label: "Talk about it", text: "Can we talk about it?" });
  if (mood === "overwhelmed" || (score !== undefined && score <= 2)) actions.push({ label: "Postpone non-urgent", payload: { type: "postpone_nonurgent" } });
  return { content, cards: [{ type: "mood_support", recommendation: rec }], actions, intent: "mood_logged", mood };
}

export function suggestionPayload(action: { type: string; [k: string]: unknown }): ActionPayload {
  switch (action.type) {
    case "breathing":
      return { type: "breathing", minutes: Number(action.minutes ?? 2) };
    case "open_task":
      return { type: "open_task", taskId: String(action.taskId) };
    case "start_task":
      return { type: "start_task", taskId: String(action.taskId) };
    case "break_down":
      return { type: "break_down", taskId: String(action.taskId) };
    case "postpone_nonurgent":
      return { type: "postpone_nonurgent" };
    case "show_top3":
      return { type: "show_top3" };
    default:
      return { type: "cancel_pending" };
  }
}

/* ======================================================================== free conversation */

export async function conversationalReply(turn: Turn, text: string, mode: "chat" | "support"): Promise<Out> {
  const context = await buildAssistantContext({ user: turn.user, settings: turn.settings, conversation: turn.conversation, query: text, budgetChars: 1500 });
  turn.memoriesUsed = context.memories.length;
  const allowDeep = mode === "chat" || isPro(turn.settings);
  const llm = allowDeep
    ? await generateReply({ mode, contextBlock: context.block, history: turn.history, userText: text, language: turn.settings.language })
    : null;
  if (llm) return { content: llm, intent: mode };
  if (mode === "support") {
    const tasks = await listActiveTasks(turn.user.id);
    const rec = recommendForMood("stressed", tasks, context.copingMemories);
    return {
      content: `That sounds really tough, ${context.displayName}. I'm here with you. ${isPro(turn.settings) ? "" : "A few small things that might help right now:"}`.trim(),
      cards: [{ type: "mood_support", recommendation: rec }],
      actions: [
        { label: "Breathing exercise", payload: { type: "breathing", minutes: 2 }, style: "primary" },
        { label: "Show my top 3", payload: { type: "show_top3" } },
      ],
      intent: "support",
    };
  }
  return {
    content: getAi().enabled
      ? "I couldn't reach my language model just now, but I can still manage your tasks. Try \"What do I have today?\" or \"Remind me to call Ali tomorrow at 5 PM\"."
      : "I can help you add tasks, routines, plan your day, and track how you feel. Try \"What do I have today?\"",
    intent: "chat_fallback",
  };
}

export async function storeInfo(turn: Turn, text: string): Promise<Out> {
  const rules = ruleBasedMemories(text);
  const stored = await extractAndStoreMemories(turn.user.id, text, { allowLlm: rules.length === 0, background: false, source: `${turn.channel.toLowerCase()}:${turn.conversation.id}` });
  turn.learned = stored.map((m) => m.content);
  if (!stored.length) return conversationalReply(turn, text, "chat");
  const first = stored[0].content
    .replace(/^User's\s+/i, "your ")
    .replace(/^User\s+/i, "you ")
    .replace(/the user's/gi, "your")
    .replace(/the user/gi, "you")
    .replace(/you is/gi, "you are");
  return {
    content: `Got it — I'll remember that ${first.charAt(0).toLowerCase()}${first.slice(1).replace(/\.$/, "")}.${stored.length > 1 ? ` (+${plural(stored.length - 1, "more thing")})` : ""} I'll use it when planning for you.`,
    actions: [{ label: "What do you know about me?", payload: { type: "navigate", screen: "Memory" } }],
    intent: "provide_info",
  };
}

export async function todayRoutinesText(turn: Turn): Promise<string> {
  const occ = await occurrencesForDay(turn.user.id, turn.tz, turn.todayYmd, turn.settings.currentContext);
  const pending = occ.filter((o) => o.status === "PENDING");
  if (!pending.length) return "";
  return `Routines today: ${listJoin(pending.slice(0, 4).map((o) => `${o.routine.title}${o.dueTime ? ` (${o.dueTime})` : ""}`))}.`;
}

export async function taskById(turn: Turn, id: string): Promise<Task | null> {
  return getTaskForUser(turn.user.id, id);
}

export { instantLabel, TaskStatus };
