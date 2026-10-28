import { isWhatsapp } from "../channel.js";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { truncate } from "../../../lib/text.js";
import { maskPersonalNumbers } from "../../documents/extraction.js";
import { hashIndex, nearest, vote } from "./neighbours.js";

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
import { sayAction } from "../actions.js";
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
  return { content, actions: picks.slice(0, isWhatsapp(turn.channel) ? 5 : 6).map((c) => sayAction(truncate(c.examples[0], 32), c.name, c.examples[0])), intent: "help" };
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
  if (short && text.trim()) actions.push(sayAction(truncate(`Add "${text.trim()}" as a task`, 40), "create_task", `Add a task: ${truncate(text.trim(), 60)}`));
  for (const name of names) {
    if (actions.length >= 5) break;
    const c = byName(name);
    if (c) actions.push(sayAction(truncate(c.summary, 40), c.name, c.examples[0]));
  }
  return { content: lead, actions, intent: "unclear" };
}

/**
 * No command fits: "I can't do that yet" and 3 things I can do. The message is logged for review
 * (`npm run unknown:review`) unless UNKNOWN_LOG=off: masked text (maskForLog), its language and the time; never
 * the user id. The file is capped (UNKNOWN_LOG_MAX_KB, default 512) and rotated once to `.1`.
 */
export async function unknownReply(turn: Turn, text: string, lang: string | null = null): Promise<Out> {
  await logUnknown(text, lang, turn.now);
  const r = capabilityReply(turn, text, "I can't do that yet. Here are some things I can do:");
  return { ...r, actions: (r.actions ?? []).slice(0, 3), intent: "unknown" };
}

/** Words after which the next word is a person ("call Mooz", "meet Sara", "sir Imran"). */
const PERSON_CUE = /^(?:call|calling|meet|meeting|with|text|message|msg|tell|ask|email|visit|remind|sir|madam|miss|mr|mrs|ms|dr|prof)$/i;
/** Urdu honorifics come after the name ("Ali bhai", "Sana baji", "Imran sahab"): the word before them is a person. */
const HONORIFIC = /^(?:bhai|bhaiya|baji|apa|aapi|aunty|uncle|sahab|sahib|ji)$/i;
/** Not names, even after a cue or capitalised. */
const NOT_NAMES = new Set(
  ("i me my mom mum dad mother father parents sister brother friend friends teacher doctor boss team class him her them us the a an my your his their this that it at on in to for and or back now later today tomorrow " +
    "karna karni karo kar krna karein karen kerna lena dena hai ko se ka ki ke mein aur").split(" "),
);

/**
 * Masks what could identify someone before a message is logged: CNIC and phone numbers (maskPersonalNumbers), any
 * other run of 5+ digits, e-mails, links, and likely names. ponytail: names are guessed (a capitalised word that is
 * not the first one, short acronyms like KFC kept; a word after a cue such as "call", "with", "sir", or before an
 * honorific such as "bhai", "sahab");
 * a lower-case name with no cue ("mooz is my friend") is not caught.
 */
export function maskForLog(text: string): string {
  const base = maskPersonalNumbers(text)
    .replace(/[^\s,;]+@[^\s,;]+\.[^\s,;]+/g, "[email]")
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, "[link]")
    .replace(/\d[\d\s-]{3,}\d/g, (m) => (m.replace(/\D/g, "").length >= 5 ? "[number]" : m));
  const words = base.split(/(\s+)/);
  const bareOf = (w: string) => w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
  // The word before an honorific (skipping the space between them).
  for (let i = 2; i < words.length; i += 1) {
    const prev = bareOf(words[i - 2] ?? "");
    if (HONORIFIC.test(bareOf(words[i])) && prev && !NOT_NAMES.has(prev.toLowerCase())) words[i - 2] = words[i - 2].replace(prev, "[name]");
  }
  let index = 0;
  let afterCue = false;
  return words
    .map((w) => {
      if (/^\s+$/.test(w) || !w) return w;
      if (w.startsWith("[")) {
        // A placeholder from above ([email], [PHONE]) is never a cue word.
        afterCue = false;
        index += 1;
        return w;
      }
      const bare = bareOf(w);
      const lower = bare.toLowerCase();
      const first = index === 0;
      index += 1;
      const cued = afterCue;
      afterCue = PERSON_CUE.test(bare);
      if (!bare || NOT_NAMES.has(lower) || afterCue) return w;
      const acronym = /^[A-Z]{2,4}$/.test(bare);
      const capitalised = /^\p{Lu}\p{Ll}/u.test(bare);
      return cued || (capitalised && !first && !acronym) ? w.replace(bare, "[name]") : w;
    })
    .join("");
}

async function logUnknown(text: string, lang: string | null, at: Date): Promise<void> {
  const path = process.env.UNKNOWN_LOG_PATH ?? join(BACKEND, "logs/unknown-utterances.jsonl");
  if (process.env.UNKNOWN_LOG?.toLowerCase() === "off" || path === "off" || !text.trim()) return;
  try {
    const guess = lang ?? (/[؀-ۿ]/.test(text) ? "ur" : vote(await nearest(text, hashIndex())).lang ?? "en");
    mkdirSync(dirname(path), { recursive: true });
    const max = Number(process.env.UNKNOWN_LOG_MAX_KB ?? 512) * 1024;
    if (existsSync(path) && statSync(path).size >= max) renameSync(path, `${path}.1`); // one older file kept
    appendFileSync(path, `${JSON.stringify({ text: maskForLog(text).slice(0, 500), lang: guess, at: at.toISOString() })}\n`);
  } catch (error) {
    console.warn("Could not log an unknown message:", error instanceof Error ? error.message : error);
  }
}
