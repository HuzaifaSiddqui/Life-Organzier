/**
 * Documents sent in chat don't ask "What type of document is this?": the type is decided here from the text (rules
 * only, no model; CLAUDE.md: deterministic code owns this). Tested in tests/docTypeGuess.test.ts.
 *
 * - SYLLABUS: a course outline (course code / "course outline" / "learning outcomes" / "grading"), so course topics
 *   are read too.
 * - SCHEDULE: a timetable or date sheet (weekday names with clock times, "timetable", "date sheet").
 * - OTHER: everything else. Deadlines and classes are still looked for, as for any upload.
 *   NOTES (which skips deadlines) is never guessed: a missed deadline costs more than an extra review row.
 */

export type GuessedDocType = "SYLLABUS" | "SCHEDULE" | "OTHER";

const SYLLABUS_WORDS = /\b(course\s+(?:outline|description|objectives?|contents?|code|title|instructor)|syllabus|learning\s+outcomes?|clos?\b|credit\s+hours?|grading\s+(?:policy|scheme|criteria)|marks?\s+distribution|recommended\s+(?:books?|texts?)|text\s*books?|prerequisites?|week\s*(?:#|no\.?)?\s*\d+\s*[:\-–])/gi;
const SCHEDULE_WORDS = /\b(time\s*table|timetable|date\s*sheet|datesheet|class\s+schedule|exam(?:ination)?\s+schedule|room\s+no|venue)\b/gi;
const WEEKDAY_TIME = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b[^\n]{0,40}?\b\d{1,2}[:.]\d{2}\b/gi;

function count(re: RegExp, text: string): number {
  return text.match(re)?.length ?? 0;
}

export function guessDocType(text: string, fileName = ""): GuessedDocType {
  const head = `${fileName}\n${text.slice(0, 20000)}`;
  const syllabus = count(SYLLABUS_WORDS, head) + (/\b(syllabus|outline|course)\b/i.test(fileName) ? 2 : 0);
  const schedule = count(SCHEDULE_WORDS, head) * 2 + Math.min(count(WEEKDAY_TIME, head), 6) + (/\b(time\s*table|timetable|schedule|date\s*sheet)\b/i.test(fileName) ? 3 : 0);
  if (syllabus >= 3 && syllabus >= schedule) return "SYLLABUS";
  if (schedule >= 3) return "SCHEDULE";
  return "OTHER";
}
