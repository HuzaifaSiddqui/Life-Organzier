import { truncate } from "../../../lib/text.js";
import type { Out, Turn } from "../dialogue.js";
import type { QuickAction } from "../types.js";
import { norm } from "./lexicon.js";
import { COMMANDS } from "./registry.js";
import type { Command, CommandCategory } from "./types.js";

/** Help and "here's what I can do" are built from the registry, so they always list real capabilities. */

const SECTIONS: Array<{ category: CommandCategory; title: string; commands: string[] }> = [
  { category: "tasks", title: "Tasks", commands: ["create_task", "update_task", "complete_task", "task_notes", "subtask_add", "query_tasks"] },
  { category: "routines", title: "Routines", commands: ["create_routine", "routine_update", "routine_pause", "routine_skip_today"] },
  { category: "settings", title: "Settings", commands: ["settings_quiet_hours", "settings_dnd", "settings_notify_devices", "settings_language"] },
  { category: "insights", title: "Insights", commands: ["insights_completed", "insights_streak", "insights_compare_week"] },
  { category: "bulk", title: "Many at once", commands: ["bulk_move_today", "bulk_postpone_nonurgent"] },
];

const byName = (name: string) => COMMANDS.find((c) => c.name === name);

export function helpReply(turn: Turn): Out {
  const lines = SECTIONS.map((s) => {
    const examples = s.commands.map(byName).filter((c): c is Command => Boolean(c)).slice(0, 3).map((c) => `"${c.examples[0]}"`);
    return `${s.title}: ${examples.join(", ")}`;
  });
  const content = [
    "Talk to me in your own words, in English or Urdu. For example:",
    ...lines,
    `You can ask for two things at once ("add X tomorrow and move Y to Friday"), and say "undo" after any change.`,
  ].join("\n");
  const picks = ["create_task", "query_tasks", "plan_day", "routine_list", "insights_completed", "settings_dnd"].map(byName).filter((c): c is Command => Boolean(c));
  return { content, actions: picks.slice(0, turn.channel === "WHATSAPP" ? 5 : 6).map((c) => ({ label: truncate(c.examples[0], 32), text: c.examples[0] })), intent: "help" };
}

const DEFAULTS = ["create_task", "query_tasks", "plan_day", "routine_list", "insights_completed"];
const STOP = new Set(["the", "my", "a", "an", "to", "and", "of", "for", "in", "on", "it", "is", "i", "me", "you", "can", "please", "what", "how", "do", "with", "this", "that"]);

function words(text: string): Set<string> {
  return new Set(norm(text).split(" ").filter((w) => w.length >= 3 && !STOP.has(w)));
}

/**
 * Nothing understood the message: 4–5 things I can do that are closest to its words (by shared words with each
 * command's summary and examples), topped up with common ones. Never a generic chat answer.
 */
export function capabilityReply(turn: Turn, text: string, lead = "I'm not sure what you'd like me to do. Here are some things I can do:"): Out {
  const said = words(text);
  const scored = COMMANDS.map((c) => {
    const vocab = words(`${c.summary} ${c.examples.join(" ")} ${c.name.replace(/_/g, " ")}`);
    let score = 0;
    for (const w of said) if (vocab.has(w)) score += 1;
    return { c, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c.name);
  const names = [...new Set([...scored, ...DEFAULTS])];
  const actions: QuickAction[] = [];
  const short = text.trim().split(/\s+/).length <= 8 && !/[?؟]\s*$/.test(text);
  if (short && text.trim()) actions.push({ label: truncate(`Add "${text.trim()}" as a task`, 40), text: `Add a task: ${truncate(text.trim(), 60)}` });
  for (const name of names) {
    if (actions.length >= 5) break;
    const c = byName(name);
    if (c) actions.push({ label: truncate(c.summary, 40), text: c.examples[0] });
  }
  return { content: lead, actions, intent: "unclear" };
}
