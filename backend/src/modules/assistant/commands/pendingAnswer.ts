import { fuzzySimilarity } from "../../../lib/text.js";
import { extractEntities } from "../entities.js";
import type { Pending, QuickAction } from "../types.js";
import { commandText } from "./copy.js";
import { matchCommand } from "./registry.js";
import type { ParseCtx } from "./types.js";

/**
 * Is this reply an answer to the open question? Then the question gets it first, before any command rule:
 * "2" picks option 2, "tomorrow" fills the date, "haan" confirms; none of them may start something else.
 * A reply that is clearly a new request ("mark all done", "pause my gym routine") is not an answer and
 * may replace the question. Pure: no I/O (the eval scores it too).
 */

/** Yes / no in English, Roman Urdu and Urdu script (whole reply). */
export const YES_NO =
  /^(?:yes|yeah|yep|yup|ya|sure|ok|okay|correct|right|confirm(?:ed)?|do it|go ahead|no|nope|nah|not really|cancel|never ?mind|stop|wrong|n|y|haa?n|han ji|haan ji|ji|jee|ji haan|theek(?: hai)?|thik(?: hai)?|bilkul|zaroor|kar do|nahi?n?|nai|na|mat|rehne do|chhor do|chor do|ہاں|جی|جی ہاں|ٹھیک ہے|بالکل|نہیں|نہ|رہنے دو)[\s.!]*$/i;
/** Short control words that only ever answer a question. */
const CONTROL = /^(?:done|ok done|that'?s it|that'?s all|skip|later|not now|bas|ho gaya|hogaya|agla|next|back|any|none|neither|both|first|second|third|last)[\s.!]*$/i;
const NUMBER = /^\s*#?\d{1,2}\s*[.)]?\s*$/;

const CONFIRM_KINDS = new Set<Pending["kind"]>(["confirm_command", "confirm_delete", "confirm_update", "mood_confirm", "typo", "prereq", "task_review", "clarify_intent"]);
const SLOT_KINDS = new Set<Pending["kind"]>(["task_draft", "routine_draft", "past_date", "capacity", "conflict", "task_review"]);

function optionLabels(p: Pending): string[] {
  if (p.kind === "command_choice") return p.candidates.map((c) => c.label);
  if (p.kind === "location_choice") return p.results.map((r) => r.name);
  return [];
}

export function isPlausibleAnswer(p: Pending, text: string, ctx: ParseCtx): boolean {
  const t = text.trim();
  if (!t) return false;
  if (YES_NO.test(t) || NUMBER.test(t) || CONTROL.test(t)) return true;
  const words = t.split(/\s+/).length;
  if (p.kind === "command_choice" || p.kind === "location_choice" || p.kind === "choose_task") {
    // A name from the list ("night reading"); task candidates are only ids here, so any short reply is a try.
    if (optionLabels(p).some((label) => fuzzySimilarity(t, label) >= 0.45 || label.toLowerCase().includes(t.toLowerCase()))) return true;
    return words <= 3 && !matchCommand(t, ctx); // a short try ("tomorrow") is asked again, never a new task
  }
  if (SLOT_KINDS.has(p.kind)) {
    const e = extractEntities(t, ctx.opts);
    if ((e.date || e.time || e.durationMinutes || e.frequency || e.flexibleTime || e.priority) && words <= 6) return true;
    // A title or a free answer ("pick another day", "add anyway"), unless it is a specific new command.
    if (p.kind === "task_draft" && p.awaiting.includes("title")) return words <= 8 && !matchCommand(t, ctx);
    if (p.kind === "routine_draft" && p.awaiting.includes("title")) return words <= 6 && !matchCommand(t, ctx);
    return /^(?:pick another day|another (?:day|date|time)|different day|add anyway|anyway|move (?:flexible )?tasks|keep the routine|do the task anyway|later today|end of day|no deadline|not sure|flexible)\b/i.test(t);
  }
  return CONFIRM_KINDS.has(p.kind) && words <= 2 && !matchCommand(t, ctx);
}

/**
 * The question again, when the reply was an answer but not one it can use ("done" to "Delete 5 tasks?").
 * Keeps the pending question open.
 */
export function answerPrompt(p: Pending, language: string): { content: string; actions: QuickAction[] } {
  const c = commandText(language);
  if (p.kind === "command_choice") return { content: c.pickNumber, actions: p.candidates.map((x, i) => ({ label: x.label, text: String(i + 1) })) };
  if (p.kind === "location_choice") return { content: c.pickNumber, actions: p.results.map((r, i) => ({ label: r.name, text: String(i + 1) })) };
  if (p.kind === "choose_task") return { content: c.pickNumber, actions: p.candidates.map((_, i) => ({ label: String(i + 1), text: String(i + 1) })) };
  if (CONFIRM_KINDS.has(p.kind)) {
    return { content: c.yesOrNo, actions: [{ label: c.yes, payload: { type: "confirm_pending" }, style: "primary" }, { label: c.no, payload: { type: "cancel_pending" } }] };
  }
  return { content: c.answerAbove, actions: [{ label: c.cancel, payload: { type: "cancel_pending" } }] };
}
