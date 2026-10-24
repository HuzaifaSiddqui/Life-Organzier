/**
 * Letters spelled out by voice or with dots become one word: "k f c", "K.F.C", "kay ef see" → "kfc".
 * - "K.F.C" (one token with dots) is joined.
 * - A run of 2+ single letters is joined; a leading "a" or "i" is the English word ("is there a k f c task").
 * - A run of 2+ letter names is joined only if it holds a name that is never an ordinary word ("kay", "ef",
 *   "aitch"…), so "see you" or "oh why" stay as they are.
 * Same rule and cases as mobile/src/utils/spelled.ts (the app normalises the transcript, the server again).
 */
const LETTER_NAMES: Record<string, string> = {
  ay: "a", bee: "b", cee: "c", see: "c", sea: "c", dee: "d", ee: "e", ef: "f", eff: "f", gee: "g", jee: "g", aitch: "h", aych: "h",
  eye: "i", jay: "j", kay: "k", el: "l", ell: "l", em: "m", en: "n", oh: "o", pee: "p", cue: "q", queue: "q", ar: "r", arr: "r",
  es: "s", ess: "s", tee: "t", tea: "t", you: "u", vee: "v", ex: "x", why: "y", wye: "y", zee: "z", zed: "z",
};
/** Names that are not everyday words: one of them makes a run of names a spelling. */
const UNAMBIGUOUS = new Set(["bee", "cee", "dee", "ef", "eff", "gee", "jee", "aitch", "aych", "jay", "kay", "el", "ell", "em", "en", "pee", "cue", "ar", "arr", "es", "ess", "tee", "vee", "ex", "wye", "zee", "zed"]);

export function normalizeSpelled(text: string): string {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  const bare = (t: string) => t.toLowerCase().replace(/[,!?]+$/, "");
  const tail = (t: string) => t.match(/[,!?]+$/)?.[0] ?? "";
  for (let i = 0; i < tokens.length; ) {
    // "K.F.C" / "k.f.c."
    if (/^(?:[a-z]\.){1,}[a-z]\.?[,!?]*$/i.test(tokens[i])) {
      out.push((tokens[i].match(/[a-z]/gi) ?? []).join("").toLowerCase() + tail(tokens[i]));
      i += 1;
      continue;
    }
    // "k f c" / "K. F. C."
    let j = i;
    while (j < tokens.length && /^[a-z]\.?$/i.test(bare(tokens[j]))) j += 1;
    let start = i;
    if (j - i >= 3 && /^[ai]$/i.test(bare(tokens[i]))) start = i + 1; // "a k f c": "a" is the article
    if (j - start >= 2) {
      if (start > i) out.push(tokens[i]);
      out.push(tokens.slice(start, j).map((t) => bare(t).replace(".", "")).join("") + tail(tokens[j - 1]));
      i = j;
      continue;
    }
    // "kay ef see"
    j = i;
    while (j < tokens.length && bare(tokens[j]) in LETTER_NAMES) j += 1;
    const names = tokens.slice(i, j).map(bare);
    if (names.length >= 2 && names.some((n) => UNAMBIGUOUS.has(n))) {
      out.push(names.map((n) => LETTER_NAMES[n]).join("") + tail(tokens[j - 1]));
      i = j;
      continue;
    }
    out.push(tokens[i]);
    i += 1;
  }
  return out.join(" ");
}
