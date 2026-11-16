/**
 * DOC_KNOWLEDGE pure rules (tested in tests/docKnowledge.test.ts): how a document is cut into searchable pieces, when a
 * chat message is a question worth looking up in the user's documents, and whether an answer is backed by the piece
 * it came from. The model only proposes; these decide.
 */

export function docKnowledgeOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DOC_KNOWLEDGE?.trim().toLowerCase() === "on";
}

export const CHUNK_SIZE = 900;
export const CHUNK_OVERLAP = 120;
export const MAX_CHUNKS = 80;

/**
 * Pieces of about CHUNK_SIZE characters, cut at paragraph / sentence / line ends where possible, each starting a little
 * before the previous one ended (CHUNK_OVERLAP) so a fact split across a cut is still found whole in one piece.
 */
export function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP, max = MAX_CHUNKS): string[] {
  const clean = text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  const out: string[] = [];
  let start = 0;
  while (start < clean.length && out.length < max) {
    let end = Math.min(clean.length, start + size);
    if (end < clean.length) {
      const window = clean.slice(start + Math.floor(size * 0.5), end);
      const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "), window.lastIndexOf("\n"));
      if (cut > 0) end = start + Math.floor(size * 0.5) + cut + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece.length >= 20) out.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}

const QUESTION_START = /^(?:what|when|where|who|whom|which|why|how|is|are|was|were|do|does|did|can|could|should|will|would|tell me|remind me what)\b/i;
/** Roman Urdu puts the question word inside the sentence ("internship kab shuru hogi"). */
const ROMAN_URDU_QUESTION = /\b(?:kya|kab|kahan|kaun|kis|kitn[aei]|kaise|konsa|konsi)\b/i;

/** A question to look up (not a command): ends with "?", starts like one, or has a Roman Urdu question word. */
export function isQuestion(text: string): boolean {
  const t = text.trim();
  if (t.length < 6 || t.length > 300) return false;
  return t.endsWith("?") || t.endsWith("؟") || QUESTION_START.test(t) || ROMAN_URDU_QUESTION.test(t);
}

const STOP = new Set("about after again also because before being between both could does doing from have having here into just more most other over same should some such than that their them then there these they this those through under until very what when where which while will with would your yours".split(" "));

/**
 * An answer must come from its piece: every number in it (dates, amounts, room numbers) appears in the piece, and so
 * does at least one of its longer words. A small model that invents a date or a name fails this and the chat goes on
 * as if no document had matched.
 */
export function answerGrounded(answer: string, excerpt: string): boolean {
  const src = excerpt.toLowerCase();
  const numbers = answer.match(/\d+/g) ?? [];
  if (numbers.some((n) => !src.includes(n))) return false;
  const words = (answer.toLowerCase().match(/[a-z]{5,}/g) ?? []).filter((w) => !STOP.has(w));
  if (!words.length) return numbers.length > 0;
  return words.some((w) => src.includes(w.slice(0, Math.max(5, w.length - 2))));
}

export type KnowledgeFact = { id: string; kind: "FACT" | "PREFERENCE" | "GOAL" | "COURSE"; content: string };
export type Knowledge = { status: "pending" | "done"; facts: KnowledgeFact[]; messageId?: string; kept?: string[]; decided?: boolean };
