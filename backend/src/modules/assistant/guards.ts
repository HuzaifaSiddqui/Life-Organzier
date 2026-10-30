/**
 * CHAT_FIXES_V2 guards on what a model may decide (default off with the flag). The model is only asked when the rules
 * are unsure; these invariants hold whatever it answers. Pure: the caller passes the command's registry facts.
 *
 *   1  a routine needs an explicit repeat cue, or "routine"/"habit" with a create verb (never a habit word alone)
 *   2a after a rule fix withdrew an intent, the model may only choose within that intent's family
 *   2b a negation ("not", "can't", "skip", …) forbids every complete-type command
 *   2c undo never comes from the model (only an explicit undo phrase, which the rules match)
 *   2d a state-changing command chosen by the model is previewed and confirmed, never run directly
 */

/**
 * Every / each / daily / weekly / weekdays / weekends / plural days ("mondays"), and the every-day words the parser
 * already reads (entities.ts → extractWeekdays: "roz", "rozana", "har roz"), so existing behaviour is kept.
 */
const REPEAT_CUE = /\b(?:every|each|daily|weekly|weekdays?|weekends?|(?:mon|tues|wednes|thurs|fri|satur|sun)days|roz|rozana|har roz)\b|ہر روز|روزانہ/i;
const ROUTINE_ASK = /\b(?:add|create|make|start|set\s*up|new|build)\b.*\b(?:routine|habit)\b/i;

/** Guard 1: the text asks for a routine outright. */
export function explicitRoutine(text: string): boolean {
  return REPEAT_CUE.test(text) || ROUTINE_ASK.test(text);
}

const NEGATION = /\b(?:not|no|can'?t|cannot|won'?t|don'?t|skip|skipping|stop|stopping)\b|n't\b/i;

export type RegistryFacts = { category: string; undoable: boolean };

/** Tasks and routines are one family: the rules can't tell a task from a routine by name. */
function family(category: string): string {
  return category === "tasks" || category === "routines" ? "items" : category;
}

/** Changes data (what the harmful-action metric counts): not a new task, a read, a mood or help. */
export function changesState(name: string, facts: RegistryFacts): boolean {
  if (name === "create_task") return false;
  return facts.undoable || name === "create_routine" || name === "snooze_task";
}

export type GuardVerdict = "run" | "confirm" | "forbidden";

/**
 * What to do with the model's choice. `withdrawnFrom`: the registry facts of the intent a rule fix took away (null
 * when the rules were merely unsure).
 */
export function guardModelChoice(text: string, choice: string, facts: RegistryFacts, withdrawnFrom: RegistryFacts | null): GuardVerdict {
  if (choice === "undo") return "forbidden"; // 2c
  if (/(?:^|_)complete/.test(choice) && NEGATION.test(text)) return "forbidden"; // 2b
  if (withdrawnFrom && family(facts.category) !== family(withdrawnFrom.category)) return "forbidden"; // 2a
  if (choice === "create_routine" && !explicitRoutine(text)) return "confirm"; // 1, when the model proposes one
  return changesState(choice, facts) ? "confirm" : "run"; // 2d
}
