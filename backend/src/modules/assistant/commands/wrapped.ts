import { z } from "zod";
import { isMood } from "../../mood/moodService.js";
import { extractOpts } from "../dialogue.js";
import { handleIntent } from "../handlers.js";
import { rulesUnderstand, type Intent } from "../nlu.js";
import type { Command, CommandCategory } from "./types.js";

/**
 * The intents that existed before the registry, wrapped (not rewritten): parse = the nlu.ts rules,
 * execute = the existing handler. The main pipeline still runs them through nlu.ts + handlers.ts;
 * the registry entries let multi-clause messages, the LLM router and help reach them too.
 */
const WRAPPED: Array<{ intent: Intent; category: CommandCategory; summary: string; examples: string[] }> = [
  { intent: "create_task", category: "tasks", summary: "Add a task or reminder", examples: ["Remind me to call Ali tomorrow at 5 PM", "kal subah 9 baje doctor ke paas jana hai"] },
  { intent: "update_task", category: "tasks", summary: "Change a task's date, time, priority, title or duration", examples: ["Move the essay to Friday", "Make the lab report urgent"] },
  { intent: "complete_task", category: "tasks", summary: "Mark a task done", examples: ["I finished the essay"] },
  { intent: "delete_task", category: "tasks", summary: "Delete a task (asks first, undo for 24 hours)", examples: ["Delete the old draft"] },
  { intent: "set_progress", category: "tasks", summary: "Record progress on a task", examples: ["I'm 50% done with the lab report"] },
  { intent: "query_progress", category: "tasks", summary: "Ask how far a task is", examples: ["How far am I with the essay?"] },
  { intent: "split_task", category: "tasks", summary: "Split a task into parts", examples: ["Split the project into 3 parts"] },
  { intent: "query_tasks", category: "tasks", summary: "What's due today, tomorrow, this week, overdue, classes", examples: ["What do I have today?", "When is the physics assignment due?"] },
  { intent: "plan_day", category: "tasks", summary: "Plan the day and find free time", examples: ["Plan my day"] },
  { intent: "read_back", category: "tasks", summary: "Read my tasks out loud", examples: ["Read back my tasks"] },
  { intent: "manage_location", category: "tasks", summary: "Remove or change a task's place (Pro)", examples: ["Remove the location from buy medicine"] },
  { intent: "snooze_task", category: "tasks", summary: "Snooze a WhatsApp reminder", examples: ["Snooze 30 minutes"] },
  { intent: "create_routine", category: "routines", summary: "Add a routine", examples: ["Daily meditation at 6 AM for 10 minutes"] },
  { intent: "set_checkin_style", category: "settings", summary: "Check-ins on or off, funny / serious / gentle", examples: ["Turn off check-ins", "Make check-ins gentle"] },
  { intent: "switch_context", category: "settings", summary: "Switch context (home, work, university)", examples: ["I'm at work"] },
  { intent: "log_mood", category: "general", summary: "Tell me how you feel", examples: ["I'm feeling stressed"] },
  { intent: "undo", category: "general", summary: "Undo the last change", examples: ["Undo"] },
  { intent: "help", category: "general", summary: "What I can do", examples: ["What can you do?"] },
];

const schema = z
  .object({
    text: z.string().max(1000),
    /** Router only: the task the user named, resolved by code. */
    ref: z.string().max(120).optional(),
    /** Router only: a short task/routine title. */
    title: z.string().max(120).optional(),
    mood: z.string().max(20).optional(),
  })
  .passthrough();

export const wrappedCommands: Command[] = WRAPPED.map(({ intent, category, summary, examples }) => ({
  name: intent,
  category,
  summary,
  examples,
  schema,
  wrapped: true,
  undoable: ["create_task", "update_task", "complete_task", "delete_task", "set_progress", "set_checkin_style"].includes(intent),
  parse: (text, ctx) => (rulesUnderstand(text, ctx.opts).intent === intent ? { text } : null),
  execute: async (turn, args) => {
    const text = String(args.text ?? "");
    const u = rulesUnderstand(text, extractOpts(turn));
    u.intent = intent;
    if (typeof args.title === "string" && args.title.trim()) u.title = args.title.trim();
    if (typeof args.ref === "string" && args.ref.trim()) u.targetRef = args.ref.trim().toLowerCase();
    if (intent === "log_mood" && typeof args.mood === "string" && isMood(args.mood) && !u.mood) u.mood = { mood: args.mood, confidence: 0.7, explicit: false };
    return handleIntent(turn, u, text);
  },
}));
