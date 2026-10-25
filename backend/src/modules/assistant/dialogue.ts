import { answerAction, commandAction, sayAction } from "./actions.js";
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
import {
  addDaysYmd,
  dueDateFromYmd,
  formatClock,
  instantLabel,
  localParts,
  localYmd,
  parseClock,
  relativeDayLabel,
  startOfLocalDay,
  zonedTimeToUtc,
} from "../../lib/time.js";
import { formatDuration, fuzzySimilarity, listJoin, plural, truncate } from "../../lib/text.js";
import { addMessage, getOrCreateConversation, readState, recentChat, saveState } from "../conversations/conversationService.js";
import { logEvent, logEventAwait } from "../events/eventService.js";
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
import { attachLocation, attachPlaceByName, findSavedPlace, isPersonalPlace, savedPlaceInTitle } from "../locations/locationService.js";
import { notifyAddedFromWhatsapp } from "../push/pushService.js";
import { getEstimateSuggestion, getPatterns } from "../patterns/patternService.js";
import { createRoutine, mandatoryConflicts, markTodayDone, occurrencesForDay, updateRoutine } from "../routines/routineService.js";
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
import { extractEntities, extractInterval, isHabitLike, isVagueTitle, saysDoneToday, titleWithoutPlace, withoutDoneToday, withoutInterval, type ExtractOptions } from "./entities.js";
import { rulesUnderstand, understand, type Understanding } from "./nlu.js";
import { generateReply } from "./responder.js";
import { handleIntent, handlePayload, resolveHandlerPending } from "./handlers.js";
import { getCommand, matchCommand, parseCtx } from "./commands/registry.js";
import { capabilityReply, unknownReply } from "./commands/capabilities.js";
import { meaningRoute, meaningRouterOn, RULES_UNSURE } from "./commands/meaning.js";
import { routeWithLlm } from "./commands/router.js";
import { getAi } from "../../ai/llm.js";
import { bankIndex } from "./commands/neighbours.js";
import type { CommandArgs, ParseCtx } from "./commands/types.js";
import { resolveCommandPending, runCommand } from "./commands/runtime.js";
import { parseMulti, runMulti } from "./commands/multi.js";
import { answerPrompt, isPlausibleAnswer } from "./commands/pendingAnswer.js";
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
  /** Pro users' saved place names (location extraction accepts them after "at" / "se"). */
  placeNames?: string[];
  /** The phone's Location reminders toggle + permission (app only; unknown on WhatsApp). */
  locationReminders?: boolean;
};

export type Out = {
  content: string;
  cards?: Card[];
  actions?: QuickAction[];
  speak?: string;
  intent?: string;
  mood?: string | null;
  /** Set when the reply answered the open question (see commands/pendingAnswer.ts). */
  answered?: string;
  /** The registry command that handled the turn, when one did (the action contract test reads it). */
  command?: string;
};

export function isPro(settings: UserSettings): boolean {
  return settings.tier === "PRO";
}

export function extractOpts(turn: Turn): ExtractOptions {
  return {
    now: turn.now,
    tz: turn.tz,
    contexts: Array.isArray(turn.settings.contexts) ? (turn.settings.contexts as string[]) : [],
    places: turn.placeNames ?? [],
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
  /** Test hook: the turn's clock (expiry of confirmations, relative dates). */
  now?: Date;
  /** Sent by the app: false when its Location reminders toggle is off or access is refused. */
  locationReminders?: boolean;
}): Promise<AssistantReply> {
  const now = input.now ?? new Date();
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
    placeNames: isPro(input.settings) ? (await prisma.savedLocation.findMany({ where: { userId: input.user.id }, select: { name: true } })).map((p) => p.name) : [],
    locationReminders: input.locationReminders,
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
    ...(out.answered ? { answered: out.answered } : {}),
    ...(out.command ? { command: out.command } : {}),
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

/** After an every-N-days routine without a time (English only, see "Urdu coverage"). */
export const ASK_ROUTINE_TIME = "Morning, afternoon, evening, or pick a time?";
/** Changing how often an existing routine repeats is a routine-screen job. English only (see "Urdu coverage"). */
export const USE_ROUTINE_SCREEN = "To change how often a routine repeats, open it on the Routines screen and set \"Repeat every N days\".";
/** "Change / switch / update my … routine to every other day", "make it every 3 days": an existing routine. */
const CHANGE_INTERVAL = /^(?:please\s+)?(?:change|switch|update|edit|move|make\s+(?:it|my|the|this|that)|set\s+(?:it|my|the|this|that))\b|\broutine\s+to\b/i;

const STRONG_SWITCH = new Set(["set_checkin_style", "query_tasks", "plan_day", "complete_task", "delete_task", "update_task", "set_progress", "query_progress", "split_task", "undo", "greeting", "help", "switch_context", "read_back"]);

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

  // The last chat reply offered something ("Say: …"): "yes", "sure, for 6 pm" runs it; anything else moves on.
  if (turn.state.pending?.kind === "offer") {
    const accepted = acceptOffer(extractOpts(turn), turn.state.pending.text, text);
    turn.state.pending = null;
    if (accepted) return handleText(turn, accepted);
  }

  // "every other day" / "every N days": a new interval routine. Changing an existing routine's interval is done
  // on the routine screen (the chat doesn't edit intervals).
  const interval = extractInterval(text);
  if (interval) {
    turn.state.pending = null;
    if (CHANGE_INTERVAL.test(text.trim())) {
      return { content: USE_ROUTINE_SCREEN, actions: [{ label: "Open routines", payload: { type: "navigate", screen: "Routines" } }], intent: "interval_change_routine_screen" };
    }
    return startIntervalRoutine(turn, text, interval);
  }

  const ctx = parseCtx(extractOpts(turn));
  // An open question gets a plausible answer first ("2", "tomorrow", "haan", "done"): no command may take it.
  const answering = turn.state.pending && isPlausibleAnswer(turn.state.pending, text, ctx) ? turn.state.pending.kind : null;
  if (!answering) {
    // Chat commands (commands/registry.ts): their rules are specific, so a match is a new request and
    // drops the open question. Everything else continues through nlu.ts and the existing handlers.
    const parts = parseMulti(text, ctx);
    if (parts) {
      turn.state.pending = null;
      return runMulti(turn, parts);
    }
    const hit = matchCommand(text, ctx);
    if (hit) {
      turn.state.pending = null;
      // Sure rules; only a strong disagreement of the meaning-based router asks first (commands/meaning.ts).
      return (await routeByMeaning(turn, text, ctx, { command: hit.command.name, confidence: 1 })) ?? runCommand(turn, hit.command.name, hit.args, { text });
    }
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
    const resolved = await resolvePending(turn, text, u, Boolean(answering));
    if (resolved) return answering ? { ...resolved, answered: answering } : resolved;
  }
  // Rules unsure (AI on): the router, guided by the nearest bank examples, picks a command; sure rules may be
  // asked about once. Greetings, answers, feelings and support are never routed.
  if (!NO_ROUTE.has(u.intent)) {
    const routed = await routeByMeaning(turn, text, ctx, { command: u.intent, confidence: u.ruleConfidence }, u);
    if (routed) return routed;
  }
  return handleIntent(turn, u, text);
}

/**
 * The meaning-based router's decision for this turn (commands/meaning.ts), run here; null keeps the rules' path.
 * A route chosen by the neighbours alone that changes data is offered as a button, never run directly.
 */
async function routeByMeaning(turn: Turn, text: string, ctx: ParseCtx, rules: { command: string; confidence: number }, u?: Understanding): Promise<Out | null> {
  try {
    const ai = getAi();
    const model = ai.enabled && ai.available;
    if (!meaningRouterOn()) {
      // The flag is off (default): the LLM router as before, only when the rules are unsure; no bank, no arbitration.
      if (!model || rules.confidence >= RULES_UNSURE) return null;
      const routed = await routeWithLlm(text, ctx);
      return routed ? runRouted(turn, text, routed.command, routed.args, u) : null;
    }
    const r = await meaningRoute(text, ctx, rules, { index: await bankIndex(model), model });
    const d = r.decision;
    if (d.kind === "rules") return null;
    if (d.kind === "unknown") return unknownReply(turn, text, r.lang);
    const summary = (name: string) => truncate(getCommand(name)?.summary ?? name, 40);
    if (d.kind === "ask") {
      return { content: "Just to be sure, did you mean:", actions: [...d.options.map((c, i) => sayAction(summary(c), c, text, i === 0 ? "primary" : undefined)), { label: "Neither", payload: { type: "cancel_pending" } }], intent: "meaning_ask" };
    }
    const command = getCommand(d.command);
    if (!command) return null;
    if (d.via === "neighbours" && (command.undoable || command.category === "bulk")) {
      return { content: "Did you mean this?", actions: [sayAction(summary(d.command), d.command, text, "primary"), { label: "No", payload: { type: "cancel_pending" } }], intent: "meaning_ask" };
    }
    return runRouted(turn, text, d.command, d.args, u);
  } catch (error) {
    console.warn("Meaning router skipped:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** Runs a routed command. A wrapped intent keeps this turn's understanding (LLM title etc.); others use the registry. */
async function runRouted(turn: Turn, text: string, name: string, args: CommandArgs, u?: Understanding): Promise<Out | null> {
  const command = getCommand(name);
  if (!command) return null;
  if (command.wrapped) {
    const base = u ?? rulesUnderstand(text, extractOpts(turn));
    return handleIntent(turn, { ...base, intent: name as Understanding["intent"], targetRef: typeof args.ref === "string" && args.ref ? args.ref.toLowerCase() : base.targetRef }, text);
  }
  return runCommand(turn, name, args, { text });
}

const SWITCH_INTENTS = new Set([...STRONG_SWITCH, "support", "thanks"]);
/** Intents the router never overrides: answers, greetings, feelings and support stay conversation. */
const NO_ROUTE = new Set(["confirm", "deny", "greeting", "thanks", "support", "log_mood", "provide_info"]);
const QUESTIONISH = /\?\s*$|^(?:what|when|where|why|how|who|which|can|could|should|would|is|are|do|does|did)\b/i;

/** A full new request ("I need to finish my report by Friday"), not an answer to the open question. */
const NEW_REQUEST = /^(?:(?:please|ok|okay|also|and|let'?s)\s+)*(?:(?:i|we)\s+(?:need|have|want|must|should|gotta)\s+to|(?:i|we)'?ll|(?:i|we)\s+will|let\s+us|remind (?:me|us) to|add|create|new task|set a reminder to|don'?t forget to)\b/i;

function isTopicSwitch(u: Understanding, text: string): boolean {
  if (SWITCH_INTENTS.has(u.intent)) return true;
  if ((u.intent === "create_task" || u.intent === "create_routine") && NEW_REQUEST.test(text.trim()) && u.title && !isVagueTitle(u.title) && u.title.split(/\s+/).length >= 2) return true;
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
/**
 * `answering`: the reply is a plausible answer to this question (commands/pendingAnswer.ts). It is then
 * never treated as a change of subject; if the question can't use it, the question is asked again.
 */
export async function resolvePending(turn: Turn, text: string, u: Understanding, answering = false): Promise<Out | null> {
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
  if (!answering && isTopicSwitch(u, text) && p.kind !== "choose_task" && p.kind !== "mood_confirm" && p.kind !== "location_choice" && p.kind !== "command_choice") {
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
              answerAction("Create a task", "clarify_intent", "I want to create a task"),
              answerAction("Set a reminder", "clarify_intent", "Set a reminder"),
              answerAction("Add a routine", "clarify_intent", "Add a routine"),
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
    case "confirm_command":
    case "command_choice": {
      const r = await resolveCommandPending(turn, text, u);
      if (r) return r;
      break;
    }
    case "routine_time": {
      // Asked once: a time or part of day ("evening", "shaam", "9:30 pm") sets it; anything else drops the question.
      turn.state.pending = null;
      const time = extractEntities(text, extractOpts(turn)).time;
      if (!time) return null;
      const updated = await updateRoutine(turn.user.id, turn.tz, p.routineId, { dueTime: time });
      if (!updated) return { content: "That routine no longer exists.", intent: "not_found" };
      const every = updated.intervalDays ? intervalLabel(updated.intervalDays).toLowerCase() : "";
      return { content: `Okay: ${updated.title} at ${time}${every ? `, ${every}` : ""}. I'll remind you then.`, cards: [{ type: "routine", routine: updated as unknown as Record<string, unknown> }], intent: "routine_time_set" };
    }
    case "confirm_delete":
    case "confirm_update":
    case "choose_task":
    case "location_choice":
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
  if (answering) {
    // An answer the question couldn't use ("done" to "Delete 5 tasks?"): ask it again, keep it open.
    turn.state.pending = p;
    if (p.kind === "task_draft" || p.kind === "routine_draft") {
      p.reasks = 0;
      const again = reask(turn);
      if (again) return again;
      turn.state.pending = p;
    }
    return { ...answerPrompt(p, turn.settings.language), intent: "pending_reask" };
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
  const chip = (l: string) => answerAction(l, "task_draft", l);
  if (awaiting.includes("date")) return ["Today", "Tomorrow", "This Friday", "Next week", "No deadline"].map(chip);
  if (awaiting.includes("time")) return ["9 AM", "12 PM", "3 PM", "6 PM", "9 PM", "End of day"].map(chip);
  if (awaiting.includes("duration")) return ["30 min", "1 hour", "2 hours", "3 hours", "Not sure"].map(chip);
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
        answerAction("Today", "past_date", "today"),
        answerAction("Tomorrow", "past_date", "tomorrow"),
        answerAction("Another date", "past_date", "another date"),
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
        actions: [answerAction("Tomorrow", "past_date", "tomorrow"), answerAction("Later today", "past_date", "another time today")],
        intent: "past_date",
      };
    }
  }

  return null;
}

/** Draft card; carries the learned-estimate suggestion (FR-RN-004 §6) when the category has a reliable ratio. */
async function draftCard(turn: Turn, draft: TaskDraft, clarity: number, missing: string[]): Promise<Card> {
  const s = draft.estimateHandled || !draft.durationMinutes ? null : await getEstimateSuggestion(turn.user.id, turn.tz, draft.category, draft.durationMinutes).catch(() => null);
  if (!s) return { type: "draft", draft, clarity, missing };
  logEvent(turn.user.id, "ESTIMATE_SUGGESTION_SHOWN", null, { category: s.category, original: s.original, suggested: s.suggested, surface: "CHAT" });
  return { type: "draft", draft, clarity, missing, estimate: s };
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
        answerAction("Create a task", "clarify_intent", `Create a task: ${draft.title ?? ""}`.trim()),
        answerAction("Set a reminder", "clarify_intent", `Remind me: ${draft.title ?? ""}`.trim()),
        answerAction("Add a routine", "clarify_intent", `Add a daily routine: ${draft.title ?? ""}`.trim()),
        { label: "Something else", payload: { type: "cancel_pending" } },
      ],
      cards: [await draftCard(turn, draft, clarity, missing)],
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
      cards: [await draftCard(turn, draft, clarity, missing)],
      actions: [
        ...slotChips(missing),
        ...(priorityHint ? (["Urgent", "High", "Low"] as const).map((p) => answerAction(p, "task_draft", `${p} priority`)) : []),
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
          answerAction("No, keep it", "typo", "no"),
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
          answerAction("Yes", "prereq", "yes"),
          answerAction("No", "prereq", "no"),
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
      cards: [await draftCard(turn, draft, confidence, [])],
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
          answerAction("Pick another day", "capacity", "pick another day", "primary"),
          ...(movable.length ? [answerAction("Move flexible tasks", "capacity", "move flexible tasks")] : []),
          answerAction("Add anyway", "capacity", "add anyway"),
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
              answerAction(`Keep ${truncate(r.title, 18)}, move task`, "conflict", "keep the routine", "primary"),
              answerAction("Do the task anyway", "conflict", "do the task anyway"),
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
  if (turn.channel === "WHATSAPP") notifyAddedFromWhatsapp(turn.user.id, [task.title]); // P2: shows up on the phone now
  turn.state.pending = null;
  focusOn(turn, task.id);

  const lines = [`Added: ${draftSummary(draft, turn.todayYmd)}`];
  if (scheduleNote) lines.push(scheduleNote);
  // FR-LB-001: Pro users get the named place as an arrival reminder (others keep the text context only).
  // No place named as such: a saved place mentioned in the title ("Print notes at uni") is attached too.
  const place = draft.location ?? savedPlaceInTitle(task.title, turn.placeNames ?? []);
  const setup = place && isPro(turn.settings) ? await proPlace(turn, task, place) : null;
  if (setup) lines.push(setup.line);
  // The place is now the task's location: the title needn't say it ("Eat burger from KFC Gulberg" → "Eat burger").
  let shown = task;
  const shorter = setup?.attached && place ? titleWithoutPlace(task.title, place) : task.title;
  if (shorter !== task.title) {
    shown = (await updateTask(turn.task, task.id, { title: shorter })) ?? task;
    lines[0] = lines[0].replace(task.title, shorter);
  }
  // Free users: the place stays in the task text; tell them what Pro would add (Pro is switched on in Settings).
  const proNudge = Boolean(place && !isPro(turn.settings)) && (await proNudgeDue(turn));
  if (proNudge) lines.push(locationText(turn).proNeeded(place!.charAt(0).toUpperCase() + place!.slice(1)));
  const actions: QuickAction[] = [
    { label: "Undo", payload: { type: "undo_task", taskId: task.id } },
    { label: "View task", payload: { type: "open_task", taskId: task.id } },
  ];
  if (proNudge) actions.unshift({ label: locationText(turn).openSettings, payload: { type: "navigate", screen: "Settings" }, style: "primary" });
  if (draft.scheduledStart) actions.splice(1, 0, { label: "Change", payload: { type: "open_task", taskId: task.id } });
  if ((!draft.durationMinutes || noSlot) && task.taskType !== TaskType.FIXED) actions.push({ label: "Find time for it", payload: { type: "suggest_slot", taskId: task.id } });

  // Stress-aware follow-up (FR-MH-003 §2).
  const mood = await latestMood(turn.user.id, 8);
  if (mood && STRESS.has(mood.mood) && (draft.durationMinutes ?? 0) >= 120) {
    lines.push(`You mentioned feeling ${mood.mood} — this is a big one. Want to break it into 45-minute chunks with breaks?`);
    actions.unshift({ label: "Break into chunks", payload: { type: "chunk_task", taskId: task.id }, style: "primary" });
    actions.push({ label: "Move to tomorrow", payload: { type: "postpone_task", taskId: task.id, days: 1 } });
  }
  return { content: lines.join("\n"), cards: [taskCard(shown, undefined, true), ...(setup?.card ? [setup.card] : [])], actions, intent: "task_created" };
}

/** The Free-user invitation to Pro shows at most once per (local) day per user, across conversations. */
async function proNudgeDue(turn: Turn): Promise<boolean> {
  const shown = await prisma.activityEvent.findFirst({ where: { userId: turn.user.id, type: "PRO_NUDGE_SHOWN", createdAt: { gte: startOfLocalDay(turn.todayYmd, turn.tz) } }, select: { id: true } });
  if (shown) return false;
  await logEventAwait(turn.user.id, "PRO_NUDGE_SHOWN", null, { feature: "location_reminders" });
  return true;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A Pro user's task names a place. A saved place (or alias: "ghar" → Home) is attached. A personal place
 * that isn't saved (home, uni, office, hostel) is never searched on the map: the card asks the user to set
 * it. Other places are searched as before. With the phone's toggle off, the card offers to turn it on first.
 */
export async function proPlace(turn: Turn, task: { id: string; title: string }, place: string): Promise<{ line: string; card: Card | null; attached: boolean }> {
  const L = locationText(turn);
  const remindersOff = turn.locationReminders === false;
  const saved = await findSavedPlace(turn.user.id, place);
  let needsPlace = !saved && isPersonalPlace(place);
  const shown = saved?.name ?? capitalize(place);
  let line: string;
  let attached = Boolean(saved);
  if (saved) {
    await attachLocation(turn.user.id, task.id, saved.id);
    line = remindersOff ? L.turnOn(shown) : L.set(saved.name, L.range[saved.preset] ?? L.range.NEARBY);
  } else if (needsPlace) {
    line = remindersOff ? L.turnOn(shown) : turn.channel === "WHATSAPP" ? L.whereIsApp(shown) : L.whereIs(shown);
  } else {
    const r = await placeLine(turn, task, place);
    attached = r.attached;
    // Not on the map ("KFC kalma chowk"): the picker searches near the user, or they drop the pin.
    needsPlace = !r.found;
    line = r.found ? r.line : turn.channel === "WHATSAPP" ? r.line : L.notFoundSet(shown);
    if (remindersOff) line += `\n${L.turnOn(shown)}`;
  }
  const card: Card | null = turn.channel !== "WHATSAPP" && (remindersOff || needsPlace) ? { type: "location_setup", taskId: task.id, place: shown, saved: !needsPlace, remindersOn: !remindersOff } : null;
  return { line, card, attached };
}

/** FR-LB-001 chat replies (English + Urdu). */
export const LOCATION_TEXT = {
  en: {
    set: (place: string, range: string) => `Location set: ${place} (${range} range). You'll be notified when nearby.`,
    notFound: (place: string) => `I created the task but couldn't find '${place}' on the map. You can add the location from the task details.`,
    choose: (title: string, place: string) => `I created '${title}'. I found several locations for '${place}':`,
    chooseEnd: "Which one? Or say 'none' to skip.",
    openToSearch: "Open task to search",
    openHint: (title: string) => `Open '${title}' and tap 'Add location' to search.`,
    none: "No location set. You can add one from the task details.",
    proNeeded: (place: string) => `Want a reminder when you get to ${place}? Location reminders come with Pro: switch to Pro and turn on Location reminders in Settings.`,
    turnOn: (place: string) => `Want a reminder about this task when you get to ${place}? Turn on Location reminders below.`,
    notFoundSet: (place: string) => `I couldn't find '${place}' on the map. Set it below and I'll remind you when you get there.`,
    whereIs: (place: string) => `Where is ${place}? Set it on the map below and I'll remind you when you get there.`,
    whereIsApp: (place: string) => `Set ${place} in the app (Settings → Saved places) and I'll remind you when you get there.`,
    openSettings: "Go to Settings",
    range: { PRECISE: "Precise", NEARBY: "Nearby", AREA: "Area" } as Record<string, string>,
  },
  ur: {
    set: (place: string, range: string) => `مقام طے ہو گیا: ${place} (${range})۔ قریب پہنچنے پر آپ کو یاد دلایا جائے گا۔`,
    notFound: (place: string) => `کام بن گیا، لیکن '${place}' نقشے پر نہیں ملا۔ آپ کام کی تفصیل سے مقام شامل کر سکتے ہیں۔`,
    choose: (title: string, place: string) => `'${title}' بن گیا۔ '${place}' کے کئی مقامات ملے:`,
    chooseEnd: "کون سا؟ یا چھوڑنے کے لیے 'none' کہیں۔",
    openToSearch: "تلاش کے لیے کام کھولیں",
    openHint: (title: string) => `'${title}' کھولیں اور تلاش کے لیے 'مقام شامل کریں' دبائیں۔`,
    none: "کوئی مقام طے نہیں ہوا۔ آپ کام کی تفصیل سے شامل کر سکتے ہیں۔",
    notFoundSet: (place: string) => `'${place}' نقشے پر نہیں ملا۔ نیچے طے کریں، وہاں پہنچنے پر میں یاد دلاؤں گا۔`,
    turnOn: (place: string) => `${place} پہنچنے پر اس کام کی یاددہانی چاہیے؟ نیچے مقام کی یاددہانیاں آن کریں۔`,
    whereIs: (place: string) => `${place} کہاں ہے؟ نیچے نقشے پر طے کریں، وہاں پہنچنے پر میں یاد دلاؤں گا۔`,
    whereIsApp: (place: string) => `ایپ میں ${place} طے کریں (ترتیبات ← محفوظ مقامات)، وہاں پہنچنے پر میں یاد دلاؤں گا۔`,
    proNeeded: (place: string) => `${place} پہنچنے پر یاددہانی چاہیے؟ مقام کی یاددہانیاں Pro میں ہیں: ترتیبات میں Pro پر جائیں اور مقام کی یاددہانیاں آن کریں۔`,
    openSettings: "ترتیبات کھولیں",
    range: { PRECISE: "قریب ترین", NEARBY: "قریب", AREA: "علاقہ" } as Record<string, string>,
  },
};

export function locationText(turn: Turn) {
  return LOCATION_TEXT[turn.settings.language === "ur" ? "ur" : "en"];
}

/** Numbered choices: up to 4 places, plus "open the task to search" when there were more. */
export function locationChoiceList(turn: Turn, results: Array<{ displayName: string }>, more: boolean): string {
  const L = locationText(turn);
  const rows = results.map((r, i) => `${i + 1}. ${truncate(r.displayName, 90)}`);
  if (more) rows.push(`${results.length + 1}. ${L.openToSearch}`);
  return rows.join("\n");
}

/**
 * Attaches the place named in chat and returns the reply line. Several geocoding matches → nothing is
 * attached yet; the numbered choices are asked and remembered in working memory (`location_choice`).
 */
export async function placeLine(turn: Turn, task: { id: string; title: string }, place: string): Promise<{ line: string; found: boolean; attached: boolean }> {
  const L = locationText(turn);
  try {
    const r = await attachPlaceByName(turn.user.id, task.id, place, turn.tz);
    if (r.kind === "not_found") return { line: L.notFound(place), found: false, attached: false };
    if (r.kind === "choices") {
      const results = r.results.slice(0, 4);
      const more = r.results.length > 4;
      turn.state.pending = { kind: "location_choice", taskId: task.id, taskTitle: task.title, place, results, more };
      return { line: `${L.choose(task.title, place)}\n${locationChoiceList(turn, results, more)}\n${L.chooseEnd}`, found: true, attached: false };
    }
    const shown = r.kind === "saved" ? r.place.name : truncate(r.result.displayName, 70);
    return { line: L.set(shown, L.range[r.place.preset] ?? L.range.NEARBY), found: true, attached: true };
  } catch (error) {
    console.warn("Could not attach place from chat", error instanceof Error ? error.message : error);
    return { line: L.notFound(place), found: false, attached: false };
  }
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
        out.actions = [sayAction(`Add ${p.prereq} review`, "create_task", `Add a task to review ${p.prereq} basics this week for 2 hours`, "primary"), ...(out.actions ?? [])];
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
      actions: ["Daily", "Weekdays", "Weekly", "Monthly"].map((l) => answerAction(l, "routine_draft", l)),
      intent: "clarify",
    };
  }
  return {
    content: `What time for "${draft.title}"? Or is it flexible?`,
    actions: [...["6 AM", "7 AM", "9 AM", "6 PM", "9 PM"].map((l) => answerAction(l, "routine_draft", l)), answerAction("Flexible", "routine_draft", "flexible")],
    intent: "clarify",
  };
}

/**
 * A new routine that repeats every N days, counted from today. With no time given it is flexible (no question
 * first). "I already took it today" marks today's occurrence done, so the first reminder is in N days.
 */
async function startIntervalRoutine(turn: Turn, text: string, intervalDays: number): Promise<Out> {
  const doneToday = saysDoneToday(text);
  const said = withoutInterval(withoutDoneToday(text));
  const draft = routineDraftFrom(turn, rulesUnderstand(said, extractOpts(turn)), said);
  return proceedWithRoutine(turn, {
    ...draft,
    frequency: RoutineFrequency.DAILY,
    daysOfWeek: null,
    dayOfMonth: null,
    flexibleTime: draft.flexibleTime || !draft.dueTime,
    intervalDays,
    anchorDate: turn.todayYmd,
    doneToday,
  });
}

/** "Every other day" / "Every 3 days". */
export function intervalLabel(intervalDays: number): string {
  return intervalDays === 2 ? "Every other day" : `Every ${intervalDays} days`;
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
    intervalDays: draft.intervalDays ?? null,
    anchorDate: draft.intervalDays ? (draft.anchorDate ?? turn.todayYmd) : null,
  });
  if (draft.intervalDays && draft.doneToday) await markTodayDone(turn.user.id, turn.tz, routine.id);
  if (turn.channel === "WHATSAPP") notifyAddedFromWhatsapp(turn.user.id, [routine.title]);
  turn.state.pending = null;
  const freq = draft.intervalDays
    ? intervalLabel(draft.intervalDays)
    : draft.frequency === RoutineFrequency.DAILY
      ? "Daily"
      : draft.frequency === RoutineFrequency.MONTHLY
        ? `Monthly (day ${draft.dayOfMonth})`
        : `Every ${listJoin((draft.daysOfWeek ?? []).map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]))}`;
  const details = [draft.dueTime ?? "flexible time", draft.durationMinutes ? formatDuration(draft.durationMinutes) : null].filter(Boolean).join(", ");
  const lines = [`Created: ${freq} ${draft.title} (${details})`];
  const askTime = Boolean(draft.intervalDays && !draft.dueTime);
  if (draft.intervalDays) {
    const next = addDaysYmd(turn.todayYmd, draft.doneToday ? draft.intervalDays : 0);
    lines.push(draft.doneToday ? `Today's is marked done; the next one is ${relativeDayLabel(next, turn.todayYmd)} (${next}).` : `Starting today (${turn.todayYmd}).`);
    // No time means no reminder (the planner needs one): ask once.
    if (askTime) {
      lines.push(ASK_ROUTINE_TIME);
      turn.state.pending = { kind: "routine_time", routineId: routine.id, title: routine.title };
    }
  }
  if (draft.priority === RoutinePriority.MANDATORY) lines.push("Mandatory routine — I'll schedule around it and ask before skipping.");
  if (draft.timeLocked) lines.push("It's time-locked: if missed, I won't move it — the next one will be ready.");
  if (learnedNote) lines.push(learnedNote);
  const actions: QuickAction[] = askTime
    ? ["Morning", "Afternoon", "Evening"].map((label) => answerAction(label, "routine_time", label.toLowerCase()))
    : [{ label: "View routines", payload: { type: "navigate", screen: "Routines" } }];
  // The routine's id, not its title: a button never depends on how its text would be read.
  if (!askTime && draft.priority !== RoutinePriority.MANDATORY) actions.push(commandAction("Make it mandatory", "routine_update", { routineId: routine.id, priority: "MANDATORY" }, { text: `Make my ${draft.title} routine mandatory` }));
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
    actions: [answerAction("Yes", "mood_confirm", "yes", "primary"), ...others.map((m) => ({ label: `I'm ${m}`, payload: { type: "log_mood", mood: m } as ActionPayload }))],
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
      instruction: `The assistant will also show these suggestions: ${rec.primary?.label ?? ""}; ${rec.suggestions.map((s) => s.label).join("; ")}. Write a short caring reply that leads into them. Do not list them. Do not ask how they feel — they just told you. Do not offer to set reminders or ask yes/no questions.`,
    });
    if (llm) content = llm;
  }
  const actions: QuickAction[] = [];
  if (rec.primary) actions.push({ label: rec.primary.label, payload: suggestionPayload(rec.primary.action), style: "primary" });
  if (STRESS.has(mood) || mood === "sad") actions.push({ label: "Talk about it", text: "Can we talk about it?", payload: { type: "talk" } });
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
  if (llm) {
    const offer = OFFER.exec(llm)?.[1]?.trim();
    if (!offer) return { content: llm, intent: mode };
    turn.state.pending = { kind: "offer", text: offer };
    // The button is a "yes" to this offer (handlePayload runs it like a typed yes); WhatsApp users type the text.
    return { content: llm, actions: [{ ...answerAction(offer.charAt(0).toUpperCase() + offer.slice(1), "offer", "yes", "primary"), text: offer }], intent: mode };
  }
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
  // No language model for a chat answer: say what I can do instead of a generic reply.
  return { ...capabilityReply(turn, text, "I can't chat about that right now, but here's what I can do:"), intent: "chat_fallback" };
}

/** The responder's "Say: …" suggestion (responder.ts asks the model to phrase actions that way). */
const OFFER = /\bSay:\s*["'“‘]?([^"”’\n]+?)["'”’]?\s*[.!]?\s*(?:$|\n)/i;
const YES_LEAD = /^(?:yes|yeah|yep|yup|sure|ok|okay|alright|haan|han|haa|ji|jee|theek hai|thik hai|go ahead|do it)\b[\s,!.]*/i;
/** Words around a yes that add nothing ("yes, scheduled for 6 pm", "sure do it then"). */
const OFFER_FILLER = new Set("please it that this then for at on in by scheduled schedule set make do sounds good fine great perfect the a and".split(" "));
const OFFER_TIME = /\s*\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi;

/**
 * "yes" → the offered text; "yes, for 6 pm" → the offer with that time; "yes, tomorrow" → with that day.
 * Null when it isn't a yes, or the yes carries a new request ("ok remove all my tasks").
 * ponytail: the time swap is a regex on "8 PM"-style times, which is what the responder writes.
 */
export function acceptOffer(opts: ExtractOptions, offer: string, text: string): string | null {
  const lead = YES_LEAD.exec(text.trim());
  if (!lead) return null;
  const rest = text.trim().slice(lead[0].length).replace(/[.!]+$/, "").trim();
  if (!rest) return offer;
  const e = extractEntities(rest, opts);
  const leftover = e.residual.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !OFFER_FILLER.has(w));
  if (leftover.length > 1 || (!e.date && !e.timeExplicit)) return leftover.length ? null : offer;
  if (e.date) return `${extractEntities(offer, opts).residual.replace(/\s+(?:for|at|on|by)\s*$/i, "")} ${rest.replace(/^(?:scheduled|schedule it|set it|make it)\s+/i, "")}`;
  return `${offer.replace(OFFER_TIME, "").trim()} at ${e.time}`;
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
