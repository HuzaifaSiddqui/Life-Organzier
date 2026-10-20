import { truncate } from "../../../lib/text.js";
import type { Out, Turn } from "../dialogue.js";
import { rulesUnderstand, type Intent } from "../nlu.js";
import type { Card, QuickAction } from "../types.js";
import { matchCommand } from "./registry.js";
import { runCommand } from "./runtime.js";
import type { CommandArgs, ParseCtx } from "./types.js";

/**
 * Several requests in one message ("add X tomorrow and move Y to Friday"). The text is split only at clause
 * boundaries (and / aur / then / also / phir / اور / پھر), and only when EVERY part parses on its own as a
 * command; "buy bread and eggs tomorrow" stays one task. Parts run in order and share one summary reply.
 */

const BOUNDARY = /\s*(?:,\s*|;\s*|\s)(?:and then|and also|and|then|also|aur phir|aur|phir|اور پھر|اور|پھر)\s+|\s*;\s+/giu;
const MAX_PARTS = 4;

/** Existing intents that may stand as one part; creating needs an explicit cue so a list of items stays one task. */
const PART_INTENTS = new Set<Intent>(["create_task", "create_routine", "update_task", "complete_task", "delete_task", "set_progress", "query_tasks", "plan_day", "set_checkin_style", "split_task", "switch_context", "manage_location"]);
const CREATE_CUE = /\b(?:remind me|add|create|new task|schedule|set a reminder|yaad dila\w*|add kar\w*|add karo)\b|شامل کر|یاد دلا/i;

export type Part = { text: string; command: string; args: CommandArgs };

function asPart(text: string, ctx: ParseCtx): Part | null {
  const clean = text.trim().replace(/^(?:then|also|phir)\s+/i, "").replace(/[,;.]+$/, "").trim();
  if (clean.split(/\s+/).length < 2) return null;
  const hit = matchCommand(clean, ctx);
  if (hit) return { text: clean, command: hit.command.name, args: hit.args };
  const u = rulesUnderstand(clean, ctx.opts);
  if (!PART_INTENTS.has(u.intent) || u.confidence < 0.85) return null;
  if ((u.intent === "create_task" || u.intent === "create_routine") && !CREATE_CUE.test(clean)) return null;
  return { text: clean, command: u.intent, args: { text: clean } };
}

/** The parts of a multi-request message, or null when it is one request. Pure (used by the eval too). */
export function parseMulti(text: string, ctx: ParseCtx): Part[] | null {
  const cuts = [...text.matchAll(BOUNDARY)].slice(0, MAX_PARTS - 1);
  if (!cuts.length) return null;
  // Try every way to cut at those boundaries, most parts first; the first where all parts parse wins.
  const options: number[][] = [];
  for (let mask = (1 << cuts.length) - 1; mask > 0; mask -= 1) options.push(cuts.map((_, i) => i).filter((i) => mask & (1 << i)));
  options.sort((a, b) => b.length - a.length);
  for (const chosen of options) {
    const pieces: string[] = [];
    let from = 0;
    for (const i of chosen) {
      const m = cuts[i];
      pieces.push(text.slice(from, m.index));
      from = (m.index ?? 0) + m[0].length;
    }
    pieces.push(text.slice(from));
    const parts = pieces.map((p) => asPart(p, ctx));
    if (parts.every((p): p is Part => p !== null)) return parts;
  }
  return null;
}

/**
 * Runs the parts in order. A part that has to ask (which task? confirm?) is asked; at most one question per
 * reply, so a later part that would also ask is left for the user to send again.
 */
export async function runMulti(turn: Turn, parts: Part[]): Promise<Out> {
  const done: string[] = [];
  const skipped: string[] = [];
  const cards: Card[] = [];
  const undo: QuickAction[] = [];
  let question: Out | null = null;
  let questionPending = turn.state.pending;
  for (const part of parts) {
    turn.state.pending = null;
    const out = await runCommand(turn, part.command, part.args);
    if (turn.state.pending) {
      if (question) {
        skipped.push(part.text);
        continue;
      }
      question = out;
      questionPending = turn.state.pending;
      continue;
    }
    done.push(out.content.split(/\r?\n/)[0]);
    cards.push(...(out.cards ?? []));
    undo.push(...(out.actions ?? []).filter((a) => a.label === "Undo"));
  }
  turn.state.pending = question ? questionPending : null;
  const lines = done.map((d) => `• ${d}`);
  if (skipped.length) lines.push(`Send this again after answering: ${skipped.map((s) => `"${truncate(s, 60)}"`).join(", ")}.`);
  if (question) lines.push(question.content);
  // One Undo per task change (undo_task); a command's own undo step is only the last one, so one Undo button for it.
  const taskUndos = undo.filter((a) => a.payload?.type === "undo_task").slice(0, 3);
  const commandUndo = undo.some((a) => a.payload?.type === "undo_command") ? [{ label: "Undo last", payload: { type: "undo_command" as const } }] : [];
  return {
    content: lines.join("\n"),
    cards: cards.slice(0, 4),
    actions: question ? question.actions : [...taskUndos.map((a, i) => ({ ...a, label: taskUndos.length > 1 ? `Undo ${i + 1}` : "Undo" })), ...commandUndo],
    intent: question ? `multi_${question.intent ?? "ask"}` : "multi",
  };
}
