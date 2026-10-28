import { maskPersonalNumbers } from "../modules/documents/extraction.js";

/**
 * Masking before text leaves the server or is logged.
 * - "log" (the unknown-message log): also guesses that a capitalised word that is not the first is a name.
 * - "provider" (text sent to a hosted model): numbers, e-mails, links and names after a cue ("call Mooz",
 *   "with Dr Imran", "Ali bhai") only. The capitalised-word guess would turn course and task names into
 *   "[name] [name]" ("Operating Systems", "KFC Gulberg"), and documents could not be read. LLM_MASK_NAMES=capitalised
 *   uses the log mode for providers too.
 */
export type MaskMode = "log" | "provider";

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
export function maskForLog(text: string, mode: MaskMode = "log"): string {
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
      return cued || (mode === "log" && capitalised && !first && !acronym) ? w.replace(bare, "[name]") : w;
    })
    .join("");
}


/** What a hosted (non-Ollama) provider receives. */
export function maskForProvider(text: string): string {
  return maskForLog(text, process.env.LLM_MASK_NAMES?.toLowerCase() === "capitalised" ? "log" : "provider");
}
