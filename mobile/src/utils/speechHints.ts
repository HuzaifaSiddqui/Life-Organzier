import type { Task } from "../types/models";

/** Most phrases the recogniser is told to expect (Android EXTRA_BIASING_STRINGS / iOS contextualStrings). */
export const MAX_SPEECH_HINTS = 100;
const COURSE_CODE = /\b[A-Z]{2,5}[-\s]?\d{3}[A-Z]?\b/g;

/**
 * Words from the user's own data that speech recognition gets wrong ("KFC", "CSC461", "Kalma Chowk"): places,
 * course codes and tags of open tasks. Case-insensitive, no repeats. Never task titles: the hints go to the
 * OS speech service, and a title can hold personal or health details ("Call mom's doctor about results").
 */
export function speechHints(tasks: Task[], max = MAX_SPEECH_HINTS): string[] {
  const open = tasks.filter((t) => t.status === "PENDING" || t.status === "IN_PROGRESS");
  const places = open.flatMap((t) => (t.locations ?? []).map((l) => l.name));
  const codes = open.flatMap((t) => t.title.match(COURSE_CODE) ?? []);
  const tags = open.flatMap((t) => t.tags ?? []);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...places, ...codes, ...tags]) {
    const phrase = String(raw).trim();
    const key = phrase.toLowerCase();
    if (!phrase || phrase.length > 60 || seen.has(key)) continue;
    seen.add(key);
    out.push(phrase);
    if (out.length >= max) break;
  }
  return out;
}
