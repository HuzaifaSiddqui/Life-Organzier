import type { MoodDetection } from "../mood/moodService.js";
import type { Entities } from "./entities.js";

/**
 * CHAT_FIXES_V2 (default off): general fixes for classes of confident rule mistakes found on the AI-written held-out
 * set (docs/known-limitations.md → Chat). Each fix only takes an action away from the rules (never adds a creating or
 * changing one): what it can't settle becomes "unsure", so with AI on the model decides and with AI off nothing is
 * done. Tested on new rows, never tuned on the held-out set.
 *
 *   D  a question or a show/list request never creates or completes  → query_tasks, unsure
 *   E  a past-tense report ("submitted my lab report") never creates  → complete_task (the item is looked up)
 *   H  a negation or stop ("not going to yoga today") never creates   → unsure, no action
 *   I  a feeling ("feeling anxious today") never becomes a task       → log_mood
 */
export const chatFixesOn = () => process.env.CHAT_FIXES_V2?.toLowerCase() === "on";

/**
 * Words that say "make this a task" outright. Narrower than nlu's CREATE_CUE: action verbs that are also cues there
 * ("book", "schedule") are left out. Shared with OOS_CONFIRM (nlu.ts → bareImperative).
 */
export const TASK_CUE = /\b(?:remind (?:me|us)|add|create|new task|todo|to-do|need to|have to|must|should|got to|gotta|gonna|going to|want to|plan to|don'?t forget|remember to|set (?:a )?reminder|i will|i'?ll|task)\b/i;

/** A question (not a polite request: "can you move it…" asks for an action and is left to the rules). */
const QUESTION = /\?\s*$|^(?:what|when|where|why|how|who|which|whose|am|is|are|was|were|do|does|did|have|has|had)\b/i;
const POLITE_REQUEST = /^(?:please\s+)?(?:can|could|would|will)\s+(?:you|u)\b/i;
const SHOW = /^(?:(?:please|can you|could you)\s+)?(?:show|list|display|view|see|give me|tell me|let me see)\b/i;
/** A report of something already done, at the start of the message. */
const PAST = /^(?:(?:i|we)\s+)?(?:(?:just|already|finally)\s+)?(?:took|did|finished|completed|submitted|paid|sent|attended|called|cleaned|watered|returned|wrote|read|handed in|turned in|went to)\b/i;
const FUTURE = /\b(?:will|tomorrow|tonight|later|next|again|every|remind)\b/i;
/** Not doing, skipping or stopping something (an existing item, so never a new one). */
const NEGATE = /^(?:(?:i'?m|i am|we'?re|i|we)\s+)?(?:(?:not|never)\s+(?:doing|going|attending|making|having)|won'?t\s+(?:do|make|go|be)|can'?t\s+(?:do|make|go)|(?:skip|skipping|stop|stopping|pause|pausing|drop(?:ping)?)\b)/i;
/** A first-person state ("I'm exhausted", "feeling low"), with no action verb after it. */
const STATE = /^(?:(?:i'?m|i am|i feel|i'?ve been|been|feeling)\s+)(?:so\s+|really\s+|very\s+|kind of\s+|a bit\s+|super\s+)?[a-z]+/i;

/** A clock time written out ("at 10 am", "5:30", "noon"); "tonight" alone is not one. */
const CLOCK = /\b(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2}|noon|midnight)\b/i;

type Decision = { intent: string; confidence: number };
const CREATES = new Set(["create_task", "create_routine"]);

/** The rules' decision, with the CHAT_FIXES_V2 classes applied (call only when the flag is on). */
export function applyChatFixes<T extends Decision>(text: string, _e: Pick<Entities, "timeExplicit">, mood: MoodDetection | null, rule: T): T & { fix?: "D" | "E" | "H" | "I" } {
  const t = text.trim();
  // "not going to …" says what won't happen; it is not the task cue "going to".
  const cue = TASK_CUE.test(t.replace(/\b(?:not|never)\s+going to\b/gi, " "));
  if (cue) return rule;
  // D: questions and show/list requests read; they never create or complete.
  if ((CREATES.has(rule.intent) || rule.intent === "complete_task") && ((QUESTION.test(t) && !POLITE_REQUEST.test(t)) || SHOW.test(t))) return { ...rule, intent: "query_tasks", confidence: 0.6, fix: "D" };
  if (!CREATES.has(rule.intent)) return rule;
  // E: a report of something done completes the matching item (looked up in the user's tasks and routines).
  if (PAST.test(t) && !FUTURE.test(t)) return { ...rule, intent: "complete_task", confidence: 0.8, fix: "E" };
  // H: not doing / skipping / stopping something is about an existing item: unsure, the rules do nothing.
  if (NEGATE.test(t)) return { ...rule, intent: "unclear", confidence: 0.5, fix: "H" };
  // I: a feeling is a mood report, even with "today"; an explicit time ("… at 5") keeps it a task.
  if (rule.intent === "create_task" && mood && STATE.test(t) && !CLOCK.test(t)) return { ...rule, intent: "log_mood", confidence: Math.max(0.75, mood.confidence), fix: "I" };
  return rule;
}
