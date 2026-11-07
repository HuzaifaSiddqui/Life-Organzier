/**
 * Task collaboration in chat, voice and WhatsApp: the pure wording rules (no I/O; shareIntent.ts loads the
 * connections and asks the model). Tested in tests/shareIntent.test.ts.
 */

export type Connected = { id: string; username: string | null; displayName: string | null };
export type Mention = { person: Connected; label: string; said: string[] };
export type ShareCue = "together" | "assign" | "none" | "unsure";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const label = (p: Connected) => (p.username ? `@${p.username}` : p.displayName?.trim() || "Someone");

/** Name words that are also ordinary English words: they count only as "@name" or written with a capital. */
const COMMON_WORDS = new Set([
  "will", "may", "mark", "rose", "grace", "faith", "hope", "joy", "june", "april", "august", "bill", "art", "sunny", "summer", "dawn", "eve", "max",
  "rich", "sky", "star", "noor", "amber", "ray", "chase", "pat", "sage", "miles", "victor", "harry", "frank", "jack", "page", "day", "lane",
]);

/**
 * Connected people named in the text: "@username" anywhere, or a username / name word (3+ letters) as a whole word.
 * A name word shared by two connections names both (the user is asked which one).
 */
export function findMentions(text: string, people: Connected[]): Mention[] {
  const out: Mention[] = [];
  for (const p of people) {
    const said = new Set<string>();
    const handles = [p.username, ...(p.displayName ?? "").split(/\s+/)].filter((w): w is string => Boolean(w && w.length >= 3));
    for (const w of handles) {
      const atRe = new RegExp(`(?:^|[^\\w@])@${esc(w)}(?![\\w])`, "i");
      if (atRe.test(text)) {
        said.add(w);
        continue;
      }
      const re = new RegExp(`(?:^|[^\\w@])(${esc(w)})(?![\\w])`, "i");
      const m = re.exec(text);
      if (!m) continue;
      const word = m[1];
      if (COMMON_WORDS.has(w.toLowerCase()) && word[0] !== word[0].toUpperCase()) continue;
      said.add(w);
    }
    if (said.size) out.push({ person: p, label: label(p), said: [...said] });
  }
  return out;
}

const SOCIAL = "call|phone|ring|text|sms|email|e-mail|mail|message|msg|dm|whatsapp|visit|see|thank|congratulate|wish|pay|repay|pick up|pickup|drop off|drop|collect|ask about|remind me about|meet up|lunch|dinner|coffee|chat|talk|speak|catch up";

/** What the wording says about the people named (`names`: the words used for them). Pure. */
export function shareCue(text: string, names: string[]): ShareCue {
  if (!names.length) return "none";
  const n = `@?(?:${names.map(esc).join("|")})`;
  const t = text.replace(/[’]/g, "'");
  const has = (re: string) => new RegExp(re, "i").test(t);
  // Only for them: assigning, delegating, asking or telling them to do it, or "Ali should …".
  if (has(`\\b(?:assign|delegate|hand over|give)\\b[^.?!]*?\\bto\\s+${n}\\b`) || has(`\\bassign\\s+(?:it\\s+)?${n}\\b`)) return "assign";
  if (has(`\\b(?:ask|tell|remind|have|get|let)\\s+${n}\\s+(?:to|that)\\b`) || has(`\\bfor\\s+${n}\\s+to\\b`)) return "assign";
  if (has(`(?:^|[,.;]\\s*)${n}\\s*,?\\s+(?:should|needs?\\s+to|has\\s+to|must|ought\\s+to)\\b`) || has(`\\b${n}\\s+(?:should|needs?\\s+to|has\\s+to|must)\\b`)) return "assign";
  // About them, not with them: their things, calling / visiting / paying them.
  if (has(`\\b${n}'s\\b`)) return "none";
  if (has(`\\b(?:${SOCIAL})\\s+(?:with\\s+|to\\s+)?${n}\\b`)) return "none";
  // A meeting with them may be theirs too, or just the user's: the model (or the user) decides.
  if (has(`\\b(?:meet|meeting|appointment|session)\\s+(?:with\\s+)?${n}\\b`)) return "unsure";
  if (has(`\\b(?:gift|present|card|cake|flowers?)\\b[^.?!]*\\bfor\\s+${n}\\b`) || has(`\\b(?:from|about)\\s+${n}\\b`)) return "none";
  // Together: with them, them and me, we/us.
  if (has(`\\b(?:with|together with|along with|alongside|plus)\\s+${n}\\b`)) return "together";
  if (has(`\\b${n}\\s+and\\s+(?:i|me)\\b`) || has(`\\b(?:i|me)\\s+and\\s+${n}\\b`) || has(`\\b(?:we|us|our)\\b`)) return "together";
  return "unsure";
}

/** An answer to "Share this with @ali?": together, only for them, or just me. Pure. */
export function shareAnswer(text: string): "together" | "assign" | "none" | null {
  const t = text.trim().toLowerCase();
  if (/^(?:3|just (?:for )?me|only (?:for )?me|me only|myself|mine|no|nope|nah|don'?t share|not shared|keep it (?:to )?myself|just a name)\b/.test(t)) return "none";
  if (/^(?:2|only (?:for )?(?:them|him|her|@?\w+)|for (?:them|him|her) only|assign(?: it)?(?: to (?:them|him|her))?|just (?:for )?(?:them|him|her)|their task|his task|her task)\b/.test(t)) return "assign";
  if (/^(?:1|together|both|both of us|with (?:them|him|her)|we(?:'ll)? do it together|share(?: it)?|yes|yeah|yep|sure|ok(?:ay)?)\b/.test(t)) return "together";
  return null;
}

/** "Ask Ali to submit the report" → "Submit the report"; "@ali" → "Ali" in a title. Pure. */
export function titleForShare(title: string, names: string[], kind: "COLLAB" | "ASSIGN"): string {
  if (!names.length) return title;
  const n = `@?(?:${names.map(esc).join("|")})`;
  let t = title.replace(new RegExp(`^(?:please\\s+)?(?:ask|tell|remind|have|get|let)\\s+${n}\\s+(?:to\\s+)?`, "i"), "");
  t = t.replace(new RegExp(`^${n}\\s*,?\\s+(?:should|needs?\\s+to|has\\s+to|must)\\s+`, "i"), "");
  t = t.replace(new RegExp(`\\s*,?\\s*(?:and\\s+)?(?:assign|delegate|give)(?:\\s+it)?\\s+to\\s+${n}\\b`, "i"), "");
  if (kind === "ASSIGN") t = t.replace(new RegExp(`\\s+for\\s+${n}\\b`, "i"), "");
  t = t.replace(/(^|\s)@(\w)/g, "$1$2").replace(/\s{2,}/g, " ").trim();
  if (!t) return title;
  return t.charAt(0).toUpperCase() + t.slice(1);
}
