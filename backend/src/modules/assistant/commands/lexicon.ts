import { has, normalize, unify } from "../queries.js";

/**
 * Shared vocabulary for the command rules (English, Urdu script, Roman Urdu). Matching runs on
 * queries.ts normalize() text: lowercase, Urdu letters unified, punctuation removed ("today's" → "today").
 */
export { has, normalize as norm };

/** Question words: the message asks, it doesn't instruct. */
export const ASK =
  "show|list|view|see|what|whats|which|when|where|how|any|tell|give|is|are|do|does|did|" +
  "kya|kia|kiya|kab|kahan|kitne|kitni|kitna|konsi|kaunsi|konsa|kaunsa|kon si|kaun si|kis|kaisa|kaisi|dikhao|dikha|dikhado|batao|btao|bata|" +
  "کیا|کب|کہاں|کتنے|کتنی|کتنا|کونسی|کون سی|کونسا|کس|کیسا|کیسی|دکھا\\S*|بتا\\S*";
export const ROUTINE = "routine|routines|rotine|rotines|routeen|روٹین|روٹینز|روٹینیں";
export const TASK_WORD = "task|tasks|todo|todos|kaam|kam|کام|ٹاسک";
export const ALL = "all|every|everything|each|saare|sare|saari|sari|sab|tamam|tamaam|تمام|سارے|ساری|سب";
export const TODAY = "today|todays|tonight|aaj|aj|آج";
/** Roman Urdu / Urdu verb endings that turn a phrase into a request ("… kar do"). */
export const DO_IT = "kar do|kardo|kr do|krdo|karo|kro|kar dein|kar den|kar dain|kijiye|کر دو|کرو|کر دیں|کیجیے";

/** Words that never belong to a task or routine name. */
const STOP =
  "my|the|a|an|this|that|it|its|please|pls|plz|can you|could you|would you|will you|for me|now|for now|right now|just|only|also|then|again|" +
  "i|im|i am|ive|me|to|for|of|on|in|from|with|as|is|are|was|be|at|by|about|" +
  "meri|mera|mere|apni|apna|apne|maine|main|mein|me|mai|ne|wali|wala|wale|ki|ka|ke|ko|se|par|pe|ab|abhi|zara|bhi|hai|hain|ho|hoon|hun|" +
  "do|dein|den|dena|karo|kar|kr|raha|rahi|rha|rhi|" +
  "میری|میرا|میرے|اپنی|اپنا|اپنے|میں|نے|والی|والا|والے|کی|کا|کے|کو|سے|پر|اب|ابھی|ذرا|بھی|ہے|ہیں|ہوں|دو|دیں|کر|رہا|رہی";

function strip(t: string, alts: string): string {
  const re = new RegExp(`(?:^| )(?:${unify(alts)})(?= |$)`, "g");
  let prev = "";
  let out = ` ${t} `;
  while (prev !== out) {
    prev = out;
    out = out.replace(re, " ");
  }
  return out.replace(/\s+/g, " ").trim();
}

/** The name left after removing command words and filler: "pause my gym routine" → "gym". */
export function refFrom(text: string, commandWords: string): string {
  return strip(strip(normalize(text), commandWords), STOP);
}

/** First match of `re` in the original text (case-insensitive), group 1 trimmed of quotes and full stops. */
export function capture(text: string, re: RegExp): string | null {
  const m = re.exec(text.trim());
  return m?.[1] ? m[1].trim().replace(/^["'“‘]+|["'”’.!?]+$/g, "").trim() || null : null;
}

/** "research, draft and review" → ["Research", "Draft", "Review"]. */
export function splitList(text: string): string[] {
  return text
    .split(/\s*(?:,|;|\band\b|\baur\b|&|\+|،|اور)\s*/i)
    .map((s) => s.trim().replace(/^["'“‘]+|["'”’.!?]+$/g, "").trim())
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .slice(0, 12);
}
