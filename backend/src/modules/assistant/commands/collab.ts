import { z } from "zod";
import { HttpError } from "../../../lib/http.js";
import { fuzzySimilarity, truncate } from "../../../lib/text.js";
import { collabOn, personLabel } from "../../collab/collabRules.js";
import {
  acceptSharedTask,
  listConnections,
  listSharedTasks,
  rejectSharedTask,
  respondConnection,
  unshareTask,
  type SharedTaskView,
} from "../../collab/collabService.js";
import { commandAction } from "../actions.js";
import { focusOn, taskCard, type Turn } from "../dialogue.js";
import { askChoice } from "./runtime.js";
import type { Command, CommandArgs, Prepared } from "./types.js";

/**
 * Task collaboration from chat, voice and WhatsApp (COLLAB_TASKS): see what people shared with you, accept or decline
 * it ("accept Sana's task", "decline the poster task"), and the buttons under a shared task (Undo / Just for me) and
 * under a connection request. Sharing itself starts from an ordinary task message (shareIntent.ts).
 */

const ref = z.object({ ref: z.string().max(120).default(""), sharedTaskId: z.string().uuid().optional() }).passthrough();

function dueText(s: Pick<SharedTaskView, "dueDate" | "dueTime">, tz: string): string {
  if (!s.dueDate) return "";
  const day = new Date(s.dueDate).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: tz });
  return ` (due ${day}${s.dueTime ? ` ${s.dueTime}` : ""})`;
}

const lead = (s: SharedTaskView) => (s.reapproval ? `${personLabel(s.owner)} changed` : s.kind === "COLLAB" ? `${personLabel(s.owner)} wants to do together` : `${personLabel(s.owner)} assigned you`);

/** "accept Sana's report", "decline the poster task" → the words that name the card. */
function refOf(text: string, verbs: string): string {
  return text
    .toLowerCase()
    .replace(new RegExp(`\\b(?:${verbs})\\b`, "g"), " ")
    .replace(/\b(?:the|a|an|this|that|shared|task|tasks|card|invite|invitation|request|please|from|by|it|for me)\b/g, " ")
    .replace(/['’]s\b/g, "")
    .replace(/@/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The card the user means: by id (a button), by title or sender, or the only one waiting. */
async function prepareCard(turn: Turn, command: string, args: CommandArgs): Promise<Prepared> {
  const { cards } = await listSharedTasks(turn.user.id);
  if (typeof args.sharedTaskId === "string") {
    return cards.some((c) => c.id === args.sharedTaskId) ? { args } : { out: { content: "That shared task isn't waiting for you any more.", intent: "shared_gone" } };
  }
  if (!cards.length) return { out: { content: "Nothing shared with you is waiting for an answer.", intent: "shared_none" } };
  const words = String(args.ref ?? "").trim();
  const scored = words
    ? cards
        .map((c) => ({ c, score: Math.max(fuzzySimilarity(words, c.title), fuzzySimilarity(words, personLabel(c.owner).replace(/^@/, "")), c.title.toLowerCase().includes(words) ? 1 : 0, (c.owner.displayName ?? "").toLowerCase().split(/\s+/).includes(words.split(" ")[0]) ? 0.9 : 0) }))
        .filter((x) => x.score >= 0.5)
        .sort((a, b) => b.score - a.score)
    : cards.map((c) => ({ c, score: 1 }));
  if (scored.length === 1 || (scored.length > 1 && scored[0].score >= 0.9 && scored[1].score < 0.9)) return { args: { ...args, sharedTaskId: scored[0].c.id } };
  const options = (scored.length ? scored.map((x) => x.c) : cards).map((c) => ({ id: c.id, label: `${truncate(c.title, 24)} · ${personLabel(c.owner)}` }));
  return { out: askChoice(turn, command, args, "sharedTaskId", options, "Which one?") };
}

const sharedRequests: Command = {
  name: "shared_requests",
  category: "tasks",
  summary: "Show tasks people shared with you and connection requests waiting for your answer",
  enabled: collabOn,
  examples: ["what did people share with me", "show shared tasks", "any connection requests?"],
  schema: z.object({}).passthrough(),
  parse(text) {
    const t = text.toLowerCase();
    if (/\b(?:shared with me|share(?:d)? requests?|shared tasks?|connection requests?|friend requests?|requests? (?:for|to) me|what did (?:\w+ ){0,3}share|pending (?:invites?|cards?))\b/.test(t)) return {};
    return null;
  },
  async execute(turn) {
    const [{ cards }, { incoming }] = await Promise.all([listSharedTasks(turn.user.id), listConnections(turn.user.id)]);
    if (!cards.length && !incoming.length) return { content: "Nothing is waiting for you: no shared tasks and no requests.", intent: "shared_none" };
    const lines: string[] = [];
    if (cards.length) {
      lines.push(cards.length === 1 ? "Shared with you:" : `${cards.length} tasks shared with you:`);
      cards.slice(0, 5).forEach((c, i) => lines.push(`${i + 1}. ${c.title}${dueText(c, turn.tz)} · ${lead(c)}`));
    }
    if (incoming.length) lines.push(`${incoming.length === 1 ? "Connection request" : "Connection requests"} from ${incoming.slice(0, 5).map((c) => personLabel(c.user)).join(", ")}.`);
    // At most 5 buttons (WhatsApp numbers them): accept/decline the first card, then the first request.
    const actions = [];
    if (cards[0]) {
      actions.push(commandAction(`Accept "${truncate(cards[0].title, 20)}"`, "shared_accept", { sharedTaskId: cards[0].id }, { style: "primary" }));
      actions.push(commandAction(`Decline "${truncate(cards[0].title, 20)}"`, "shared_decline", { sharedTaskId: cards[0].id }));
    }
    if (incoming[0]) {
      actions.push(commandAction(`Accept ${truncate(personLabel(incoming[0].user), 20)}`, "connection_answer", { connectionId: incoming[0].connectionId, accept: true }));
      actions.push(commandAction(`Decline ${truncate(personLabel(incoming[0].user), 20)}`, "connection_answer", { connectionId: incoming[0].connectionId, accept: false }));
    }
    actions.push({ label: "People & sharing", payload: { type: "navigate" as const, screen: "Collab" } });
    if (cards.length > 1) lines.push(`Say "accept" or "decline" with the task's name, e.g. "accept ${truncate(cards[1].title, 24)}".`);
    return { content: lines.join("\n"), actions, intent: "shared_requests" };
  },
  undoable: false,
};

const ACCEPT_WORDS = "accept|approve|agree to|take|okay|ok";
const DECLINE_WORDS = "decline|reject|refuse|deny|say no to";

const sharedAccept: Command = {
  name: "shared_accept",
  category: "tasks",
  summary: "Accept a task someone shared with you (it is added to your plan)",
  enabled: collabOn,
  examples: ["accept Sana's task", "accept the shared report task"],
  schema: ref,
  parse(text) {
    const t = text.toLowerCase();
    if (!/\b(?:accept|approve)\b/.test(t) || !/\b(?:shared|task|card|invite|invitation|from|@\w+|\w+'s)\b/.test(t)) return null;
    if (/\b(?:request|connection|friend)\b/.test(t)) return null;
    return { ref: refOf(text, ACCEPT_WORDS) };
  },
  prepare: (turn, args) => prepareCard(turn, "shared_accept", args),
  async execute(turn, args) {
    try {
      const { shared, task } = await acceptSharedTask(turn.user, turn.tz, String(args.sharedTaskId), {}, turn.task.deviceId);
      focusOn(turn, task.id);
      return {
        content: `Added to your plan: ${task.title}${dueText(shared, turn.tz)}. ${personLabel(shared.owner)} will see that you accepted.`,
        cards: [taskCard(task)],
        actions: [{ label: "View task", payload: { type: "open_task", taskId: task.id } }],
        intent: "shared_accepted",
      };
    } catch (error) {
      if (error instanceof HttpError) return { content: error.code === "SHARED_TASK_CANCELLED" ? "That task was cancelled." : "You already answered that one.", intent: "shared_gone" };
      throw error;
    }
  },
  undoable: false,
};

const sharedDecline: Command = {
  name: "shared_decline",
  category: "tasks",
  summary: "Decline a task someone shared with you (nothing is added)",
  enabled: collabOn,
  examples: ["decline Sana's task", "reject the shared poster task"],
  schema: ref,
  parse(text) {
    const t = text.toLowerCase();
    if (!new RegExp(`\\b(?:${DECLINE_WORDS})\\b`).test(t) || !/\b(?:shared|task|card|invite|invitation|from|@\w+|\w+'s)\b/.test(t)) return null;
    if (/\b(?:request|connection|friend)\b/.test(t)) return null;
    return { ref: refOf(text, DECLINE_WORDS) };
  },
  prepare: (turn, args) => prepareCard(turn, "shared_decline", args),
  async execute(turn, args) {
    try {
      const shared = await rejectSharedTask(turn.user, turn.tz, String(args.sharedTaskId), turn.task.deviceId);
      return { content: `Okay, declined "${shared.title}". Nothing was added, and ${personLabel(shared.owner)} will see it.`, intent: "shared_declined" };
    } catch (error) {
      if (error instanceof HttpError) return { content: "You already answered that one.", intent: "shared_gone" };
      throw error;
    }
  },
  undoable: false,
};

/** Buttons under "Added and shared with @ali": Undo (cancel for everyone, delete my copy) / Just for me (keep my copy). */
const sharedCancel: Command = {
  name: "shared_cancel",
  category: "tasks",
  summary: "Stop sharing a task you just shared",
  enabled: collabOn,
  examples: [],
  schema: z.object({ sharedTaskId: z.string().uuid(), keepMine: z.boolean().default(false) }).passthrough(),
  parse: () => null,
  async execute(turn, args) {
    const id = String(args.sharedTaskId);
    try {
      const { shared, kept } = await unshareTask(turn.user, turn.tz, id, Boolean(args.keepMine), turn.task.deviceId);
      // The share's undo step is used up by the button.
      if (turn.state.undo?.kind === "share" && turn.state.undo.sharedTaskId === id) turn.state.undo = null;
      const answered = shared.participants.some((p) => p.role === "member" && p.state !== "waiting" && p.state !== "declined");
      const who = shared.participants.filter((p) => p.role === "member").map((p) => personLabel(p.user)).join(", ");
      if (kept) return { content: `Okay, "${shared.title}" is just yours now. ${who} won't get it${answered ? " (anyone who already accepted keeps their copy)" : ""}.`, intent: "shared_unshared" };
      return { content: `Undone: "${shared.title}" was removed${answered ? ". Anyone who already accepted keeps their copy" : ` and ${who} won't get it`}.`, intent: "shared_cancelled" };
    } catch (error) {
      if (error instanceof HttpError) return { content: "That shared task was already cancelled.", intent: "shared_gone" };
      throw error;
    }
  },
  undoable: false,
};

/** Buttons under a connection request ("Accept @ali" / "Decline @ali"). */
const connectionAnswer: Command = {
  name: "connection_answer",
  category: "tasks",
  summary: "Accept or decline a connection request",
  enabled: collabOn,
  examples: [],
  schema: z.object({ connectionId: z.string().uuid(), accept: z.boolean() }).passthrough(),
  parse: () => null,
  async execute(turn, args) {
    try {
      await respondConnection(turn.user, String(args.connectionId), Boolean(args.accept));
    } catch (error) {
      if (error instanceof HttpError) return { content: "That request is no longer waiting.", intent: "connection_gone" };
      throw error;
    }
    return args.accept
      ? { content: "Connected. You can now share tasks with each other: just name them in a task, e.g. \"finish the slides with them by Friday\".", intent: "connection_accepted" }
      : { content: "Okay, declined.", intent: "connection_declined" };
  },
  undoable: false,
};

/** Matched from sentences (listed in COMMANDS). */
export const collabCommands: Command[] = [sharedRequests, sharedAccept, sharedDecline];
/** Buttons only: never matched from a sentence or picked by the router. */
export const collabButtonCommands: Command[] = [sharedCancel, connectionAnswer];

