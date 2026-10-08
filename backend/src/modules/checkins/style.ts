/**
 * FR-RN-004 §6: recognise requests to change the check-in style or turn check-ins off/on
 * (English and Roman Urdu). Deterministic; the LLM is only consulted when these rules don't match.
 */
export type StyleRequest = { kind: "tone"; tone: "FUNNY" | "SERIOUS" | "GENTLE" } | { kind: "off" } | { kind: "on" } | { kind: "ask" };

const SUBJECT = String.raw`(?:reminders?|check-?\s?ins?|notifications?|nudges?|tone|style|messages?|mode)`;
const TONE_WORDS: Array<[RegExp, "FUNNY" | "SERIOUS" | "GENTLE"]> = [
  [/\b(?:serious|strict|formal|professional|sanjeeda)\b/i, "SERIOUS"],
  [/\b(?:gentle|gentler|soft|softer|kind(?:er)?|calm(?:er)?|narm|narmi)\b/i, "GENTLE"],
  [/\b(?:funny|funnier|fun|playful|jokes?|joking|humou?r(?:ous)?|mazaq(?:iya)?|mazak|mazaaq)\b/i, "FUNNY"],
];

export function parseCheckinStyle(text: string): StyleRequest | null {
  const t = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (new RegExp(String.raw`\b(?:turn|switch|shut)\s+off\s+(?:the\s+|my\s+)?(?:check-?\s?ins?|nudges?)\b|\b(?:stop|disable|no more)\s+(?:the\s+)?check-?\s?ins?\b|\bcheck-?\s?ins?\s+(?:off|band\s*(?:karo|kar do|kr do)?)\b`).test(t)) return { kind: "off" };
  if (new RegExp(String.raw`\b(?:turn|switch)\s+(?:on\s+(?:the\s+|my\s+)?check-?\s?ins?|(?:the\s+|my\s+)?check-?\s?ins?\s+(?:back\s+)?on)\b|\b(?:enable|resume|restart)\s+(?:the\s+)?check-?\s?ins?\b|\bcheck-?\s?ins?\s+(?:on|wapas|chalu)\b`).test(t)) return { kind: "on" };
  // "stop joking", "no more jokes", "mazaq band karo", "serious ho jao"
  if (/\b(?:stop|quit|enough with the)\s+(?:the\s+)?(?:joking|jokes|being funny)\b|\bno more jokes\b|\b(?:mazaq|mazak|mazaaq)\s+(?:band|na karo|mat karo)\b/.test(t)) return { kind: "tone", tone: "SERIOUS" };
  if (/\b(?:serious|sanjeeda)\s+(?:ho\s+jao|bano|raho|ho jaen|ho jayen)\b/.test(t)) return { kind: "tone", tone: "SERIOUS" };
  if (/\b(?:narmi\s+se|naram\s+(?:raho|bano|ho jao))\b/.test(t)) return { kind: "tone", tone: "GENTLE" };
  if (/\b(?:mazaq|mazak|mazaaq)\s+(?:karo|kiya karo|wapas)\b/.test(t)) return { kind: "tone", tone: "FUNNY" };
  // A tone word tied to reminders/check-ins/tone: "be more serious with reminders", "change your tone to gentle".
  const tied =
    new RegExp(String.raw`\b${SUBJECT}\b.{0,40}\b(?:serious|strict|formal|gentle|gentler|soft|softer|funny|funnier|playful|fun)\b`).test(t) ||
    new RegExp(String.raw`\b(?:serious|strict|formal|gentle|gentler|soft|softer|funny|funnier|playful|fun)\b.{0,25}\b${SUBJECT}\b`).test(t) ||
    // "be more serious" only as the whole request ("…with me", "please"), not "be serious about my exams".
    /\bbe\s+(?:more\s+|a bit\s+|a little\s+)?(?:serious|gentle|gentler|funny|funnier|playful|strict)(?:\s+(?:with me|please|now|from now on))*[\s.!]*$/.test(t);
  if (tied) {
    for (const [re, tone] of TONE_WORDS) if (re.test(t)) return { kind: "tone", tone };
  }
  if (new RegExp(String.raw`\bchange\s+(?:your|the|my)\s+(?:tone|style)\b|\b(?:check-?\s?in|reminder)\s+style\b`).test(t)) return { kind: "ask" };
  return null;
}
