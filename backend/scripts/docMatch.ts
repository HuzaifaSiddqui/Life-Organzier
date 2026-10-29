/**
 * How the document scorer (scripts/eval-documents.ts) matches an expected item with an extracted one. Used for the
 * private manifest's `title` field; the synthetic fixtures keep `titleContains` (an exact, case-insensitive substring).
 */

const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);

/** Edit distance, stopping early above `max`. */
function within(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] <= max;
}

/**
 * `title` match: every word of 3+ characters in the expected title appears in the extracted title (any order, case and
 * punctuation ignored); a word of 5+ characters may differ by one letter (an OCR slip: "Asignment"). Words of 1–2
 * characters ("of", "3") are ignored, so write the distinctive words: "Operating Systems final".
 */
export function titleMatches(expected: string, extracted: string): boolean {
  const want = words(expected).filter((w) => w.length >= 3);
  if (!want.length) return false;
  const have = words(extracted);
  return want.every((w) => have.some((h) => h === w || (w.length >= 5 && within(w, h, 1))));
}

/** "4 PM", "4:00 pm", "16:00" → minutes after midnight; null when not a time. */
export function clockMinutes(t: string | null | undefined): number | null {
  const m = (t ?? "").trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** An expected time matches when both read as the same clock time (empty expected time = any time). */
export function timeMatches(expected: string | undefined, extracted: string | null): boolean {
  if (!expected?.trim()) return true;
  const a = clockMinutes(expected);
  return a !== null && a === clockMinutes(extracted);
}
