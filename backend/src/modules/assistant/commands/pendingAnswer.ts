import { fuzzySimilarity } from "../../../lib/text.js";
import { answerAction } from "../actions.js";
import { cleanTitle, extractEntities } from "../entities.js";
import { chatFixesOn } from "../chatFixes.js";
import { shareAnswer } from "../shareRules.js";
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

const CONFIRM_KINDS = new Set<Pending["kind"]>(["routine_preview", "split_preview", "confirm_command", "confirm_delete", "confirm_update", "mood_confirm", "typo", "prereq", "task_review", "clarify_intent"]);
const SLOT_KINDS = new Set<Pending["kind"]>(["task_draft", "routine_draft", "past_date", "capacity", "conflict", "task_review", "routine_time"]);

/** The names offered: command / location choices carry them; for "which task?" the caller passes the task titles. */
function optionLabels(p: Pending, titles: string[] = []): string[] {
  if (p.kind === "command_choice") return p.candidates.map((c) => c.label);
  if (p.kind === "location_choice") return p.results.map((r) => r.name);
  if (p.kind === "choose_task") return titles;
  return [];
}

/**
 * The reply names one of the options ("call mom" to "Which task: Call mom / Book dentist?"). A reply that starts with
 * an action must name it exactly: "update the report" is not "Quarterly report", and "move the dentist appointment to
 * monday" is a new request (it carries its own change), not a pick.
 */
function namesOption(p: Pending, t: string, titles: string[]): boolean {
  if (t.split(/\s+/).length > 5) return false;
  const said = t.toLowerCase();
  // Same words, ignoring "the" and punctuation (fuzzy scores a longer reply that contains the title as a match).
  const plain = (x: string) => x.toLowerCase().replace(/\bthe\b/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const strict = ACTION_START.test(t);
  return optionLabels(p, titles).some((label) => (strict ? plain(label) === plain(t) : fuzzySimilarity(t, label) >= 0.45 || label.toLowerCase().includes(said)));
}

/**
 * CHAT_FIXES_V2: closes whatever question is open ("cancel that", "forget it"); never a delete. A bare "cancel" or
 * "never mind" is a no to the question, as before.
 */
export const CANCEL_QUESTION = /^(?:no[,.]?\s+)?(?:cancel|forget|drop|leave|stop)\s+(?:it|that|this|about it)[\s.!]*$/i;

const PRONOUN = /^(?:it|its|her|him|his|them|their|this|that|there|wo|woh|usse|use|isko|usko|unko)$/i;
const VERB = /^(?:remind|make|set|put|move|change|book|call|schedule|do|keep|plan)$/i;

/**
 * A longer reply still answers when it adds nothing new: once the date, time and filler are gone, what is left is
 * only pronouns and words of the draft's title ("I'll call her tomorrow", "we will do it in the evening",
 * "I need it by Friday"). "I need to call mom's doctor tomorrow" adds "doctor": a new task, not Call mom's date.
 */
export function refersBack(p: Pending, text: string, ctx: ParseCtx, allowVerb = false): boolean {
  const title = "draft" in p && p.draft && typeof p.draft === "object" && "title" in p.draft ? String(p.draft.title ?? "") : "";
  const words = (s: string) => (s.toLowerCase().replace(/['’]s\b/g, "").match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const own = new Set(words(title));
  const said = words(cleanTitle(extractEntities(text, ctx.opts).residual));
  // allowVerb: the verb of "make it friday", "remind me tomorrow at 5" adds nothing either.
  return said.every((w, i) => PRONOUN.test(w) || own.has(w) || (allowVerb && i === 0 && VERB.test(w)));
}

/** A reply that starts with an action ("add milk", "update the report", "set an alarm for 6 am"). */
const ACTION_START = /^(?:(?:please|ok(?:ay)?|also|and|now|so)[,\s]+)*(?:add|set|create|make|remind|book|call|move|change|update|delete|remove|complete|finish|mark|rename|share|schedule|cancel|plan|show|list|start)\b/i;
/** A question ("what's due tomorrow?", "who made you?"); "can't" is not "can" (the apostrophe ends the word). */
const QUESTION = /\?\s*$|^(?:what|when|where|who|why|how|can|could|is|are|(?:do|does)\s+(?:i|you|we|they|my))\b(?!['’])/i;
/**
 * To a date / time question, "when I get home", "after lunch", "by friday" is the answer; not when it is a question:
 * a "?", or "when" + is / does / can … ("when is my dentist appointment", "when can I do this").
 */
const WHEN_ANSWER = /^(?:when(?!\s+(?:is|are|was|were|do|does|did|will|can|could|should|would)\b)|after|before|by)\b(?!.*\?\s*$)/i;

/** The open question asks for a date or time. */
function asksDateOrTime(p: Pending): boolean {
  if (p.kind === "task_draft" || p.kind === "routine_draft") return p.awaiting.some((a) => a === "date" || a === "time");
  return p.kind === "past_date" || p.kind === "routine_time";
}

/**
 * CHAT_FIXES_V2: the reply is clearly a new request, not an answer to the open question: a question, or a reply that
 * starts with an action. Exception: to a date / time question, an action about "it / that / this" with a date or time
 * is still the answer ("make it friday", "set it for 6 pm"). A number, yes / no or a control word is always an answer.
 */
export function isNewRequest(p: Pending, text: string, ctx: ParseCtx, titles: string[] = []): boolean {
  const t = text.trim();
  if (!t || YES_NO.test(t) || NUMBER.test(t) || CONTROL.test(t) || CANCEL_QUESTION.test(t)) return false;
  // A name from the options is the answer, even "call mom" or "finish report".
  if (namesOption(p, t, titles)) return false;
  if (asksDateOrTime(p) && WHEN_ANSWER.test(t)) return false;
  if (QUESTION.test(t)) return true;
  if (!ACTION_START.test(t)) return false;
  // "remind me tomorrow at 5", "call her tomorrow", "make it friday": a date or time and nothing new beside it.
  if (asksDateOrTime(p)) {
    const e = extractEntities(t, ctx.opts);
    if ((e.date || e.time) && refersBack(p, t, ctx, true)) return false;
  }
  return true;
}

export function isPlausibleAnswer(p: Pending, text: string, ctx: ParseCtx, titles: string[] = []): boolean {
  const t = text.trim();
  if (!t) return false;
  if (chatFixesOn() && isNewRequest(p, t, ctx, titles)) return false;
  if (YES_NO.test(t) || NUMBER.test(t) || CONTROL.test(t)) return true;
  if (chatFixesOn() && (CANCEL_QUESTION.test(t) || namesOption(p, t, titles) || (asksDateOrTime(p) && WHEN_ANSWER.test(t)))) return true;
  const words = t.split(/\s+/).length;
  if (p.kind === "command_choice" || p.kind === "location_choice" || p.kind === "choose_task") {
    // A name from the list ("night reading"); task candidates are only ids here, so any short reply is a try.
    // Only a short reply can be a name from the list: "Add a task … at home" is not picking "home".
    if (namesOption(p, t, [])) return true;
    return words <= 3 && !matchCommand(t, ctx); // a short try ("tomorrow") is asked again, never a new task
  }
  if (SLOT_KINDS.has(p.kind)) {
    const e = extractEntities(t, ctx.opts);
    if ((e.date || e.time || e.durationMinutes || e.frequency || e.flexibleTime || e.priority) && (words <= 6 || (words <= 12 && refersBack(p, t, ctx)))) return true;
    // A title or a free answer ("pick another day", "add anyway"), unless it is a specific new command.
    if (p.kind === "task_draft" && p.awaiting.includes("title")) return words <= 8 && !matchCommand(t, ctx);
    if (p.kind === "routine_draft" && p.awaiting.includes("title")) return words <= 6 && !matchCommand(t, ctx);
    return /^(?:pick another day|another (?:day|date|time)|different day|add anyway|anyway|move (?:flexible )?tasks|keep the routine|do the task anyway|later today|end of day|no deadline|not sure|flexible|no reminders?|without (?:a )?reminder|don'?t remind me|bina reminder|reminder (?:nahi|nahin|mat))\b/i.test(t);
  }
  // PR E: "How should I split it?": the names ("outline, draft, review"), unless it is a command.
  if (p.kind === "split_ask") return words <= 20 && !matchCommand(t, ctx);
  // "Why are you declining?": a quick-pick number, cancel, or a short reason that isn't itself a command.
  if (p.kind === "decline_reason") return words <= 25 && !matchCommand(t, ctx);
  // "Share this with @ali?": together / only for them / just me, or a person's name when one name fits two people.
  if (p.kind === "share_choice") {
    const said = t.toLowerCase();
    return words <= 6 && (shareAnswer(t) !== null || (p.draft.share?.people ?? []).some((x) => said.includes(x.label.replace(/^@/, "").toLowerCase())));
  }
  return CONFIRM_KINDS.has(p.kind) && words <= 2 && !matchCommand(t, ctx);
}

/**
 * The question again, when the reply was an answer but not one it can use ("done" to "Delete 5 tasks?").
 * Keeps the pending question open.
 */
export function answerPrompt(p: Pending, language: string): { content: string; actions: QuickAction[] } {
  const c = commandText(language);
  if (p.kind === "command_choice") return { content: c.pickNumber, actions: p.candidates.map((x, i) => answerAction(x.label, "command_choice", String(i + 1))) };
  if (p.kind === "location_choice") return { content: c.pickNumber, actions: p.results.map((r, i) => answerAction(r.name, "location_choice", String(i + 1))) };
  if (p.kind === "choose_task") return { content: c.pickNumber, actions: p.candidates.map((_, i) => answerAction(String(i + 1), "choose_task", String(i + 1))) };
  if (CONFIRM_KINDS.has(p.kind)) {
    return { content: c.yesOrNo, actions: [{ label: c.yes, payload: { type: "confirm_pending" }, style: "primary" }, { label: c.no, payload: { type: "cancel_pending" } }] };
  }
  return { content: c.answerAbove, actions: [{ label: c.cancel, payload: { type: "cancel_pending" } }] };
}
