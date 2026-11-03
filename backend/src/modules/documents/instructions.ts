import { z } from "zod";
import { getAi } from "../../ai/llm.js";
import { editDistance } from "../../lib/text.js";
import { addDaysYmd, weekdayOfYmd } from "../../lib/time.js";
import { parseCtx } from "../assistant/commands/registry.js";
import { extractWeekdays } from "../assistant/entities.js";
import { RANGE_WORD, resolveRange } from "../assistant/ranges.js";
import type { ExtractedDeadline, ExtractedSchedule } from "./extraction.js";

/**
 * DOC_INSTRUCTIONS (default off): "only Dr. Ahmed's classes", "just the exams", "Mondays and Wednesdays", "only CS-301".
 * The document is read once; every item gets structured fields (who, course, kind, days, room), stored on the document;
 * an instruction becomes a filter over those items, so a new instruction never reads the file again. English only.
 *
 * The instruction is read by rules first; the LOCAL model (Ollama only, never a hosted provider, never name-masked)
 * only when the rules leave words they can't place. What isn't understood is said back and asked, never ignored.
 */
export const docInstructionsOn = () => process.env.DOC_INSTRUCTIONS?.toLowerCase() === "on";

export type ItemKind = "class" | "exam" | "quiz" | "assignment" | "other";
/** The structured fields of one extracted item. */
export type ItemMeta = { person: string | null; courseCode: string | null; course: string | null; kind: ItemKind; days: number[]; room: string | null };

/* ------------------------------------------------------------------ people */

const TITLES = "dr|prof|professor|sir|madam|mam|maam|ma'am|miss|mrs|mr|ms|engr";
/** "Dr. Ahmed Khan", "Prof Sara", "Sir Bilal", "Ms. Hina Malik" (names capitalised in documents). */
// Name words start with a letter; OCR may put a digit inside ("Ma1ik").
const TITLED = new RegExp(`\\b(?:${TITLES})\\.?\\s+([A-Z][A-Za-z0-9'-]+(?:\\s+[A-Z][A-Za-z0-9'-]+){0,2})`, "i");
/** "Instructor: Ahmed Khan", "Teacher - Sara Ali", "Taught by Bilal" */
const LABELLED = /\b(?:instructor|teacher|lecturer|faculty|tutor|taught by|course teacher)\s*[:\-–]?\s*((?:(?:dr|prof|sir|madam|miss|mrs|mr|ms)\.?\s+)?[A-Za-z][A-Za-z0-9'.-]+(?:\s+[A-Za-z][A-Za-z0-9'.-]+){0,2})/i;
const NOT_A_NAME = /^(?:room|hall|lab|mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|exam|quiz|class|section|time|date|venue)\b/i;

/** The person a line names, with the title kept for display ("Dr. Ahmed Khan"); null when none. */
export function personIn(line: string): string | null {
  const l = LABELLED.exec(line);
  if (l && !NOT_A_NAME.test(l[1].trim())) return tidyName(l[1]);
  const t = TITLED.exec(line);
  if (t) return tidyName(t[0]);
  return null;
}

function tidyName(name: string): string {
  return name
    .replace(/\s+(?:room|hall|lab|mon|tue|wed|thu|fri|sat|sun)\b.*$/i, "")
    .replace(/[,;:|]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** OCR slips in names: digits read for letters. */
const OCR_FIX: Array<[RegExp, string]> = [
  [/rn/g, "m"],
  [/0/g, "o"],
  [/1/g, "l"],
  [/5/g, "s"],
  [/8/g, "b"],
  [/\|/g, "l"],
];

/** Lower-case name words, titles and punctuation removed, OCR digit slips mended. */
export function nameTokens(name: string): string[] {
  let n = name.toLowerCase();
  for (const [re, s] of OCR_FIX) n = n.replace(re, s);
  return n
    .replace(new RegExp(`\\b(?:${TITLES})\\b\\.?`, "g"), " ")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/** Two name words are the same: equal, or a spelling / OCR variant (one edit, two for long words). */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  return editDistance(a, b) <= (Math.max(a.length, b.length) >= 7 ? 2 : 1);
}

/** The words of `query` all appear in `name` (a single letter matches as an initial: "A. Khan" ~ "Ahmed Khan"). */
export function nameMatches(query: string, name: string): boolean {
  const q = nameTokens(query);
  const n = nameTokens(name);
  if (!q.length || !n.length) return false;
  return q.every((w) => n.some((x) => (w.length === 1 ? x.startsWith(w) : sameWord(w, x))));
}

/** The same person written two ways (OCR noise, spelling): same number of words, each a variant; never by initials. */
function samePerson(a: string, b: string): boolean {
  const x = nameTokens(a);
  const y = nameTokens(b);
  return x.length === y.length && x.every((w, i) => sameWord(w, y[i]));
}

/** The distinct people in the items: variants of one name collapse to the most frequent spelling. */
export function peopleIn(names: Array<string | null>): string[] {
  const groups: Array<{ name: string; count: number; variants: Map<string, number> }> = [];
  for (const n of names) {
    if (!n) continue;
    const g = groups.find((x) => samePerson(x.name, n));
    if (g) {
      g.count += 1;
      g.variants.set(n, (g.variants.get(n) ?? 0) + 1);
    } else groups.push({ name: n, count: 1, variants: new Map([[n, 1]]) });
  }
  // The most frequent spelling; on a tie, one without OCR digits ("Malik" over "Ma1ik").
  return groups.map((g) => [...g.variants].sort((a, b) => b[1] - a[1] || Number(/\d/.test(a[0])) - Number(/\d/.test(b[0])))[0][0]);
}

/** Who a requested name means among the document's people: one, several (ask), or none (say so, show the nearest). */
export function matchPerson(query: string, people: string[]): { matches: string[]; nearest: string[] } {
  const matches = people.filter((p) => nameMatches(query, p));
  if (matches.length) return { matches, nearest: [] };
  const q = nameTokens(query);
  const score = (p: string) => Math.min(...nameTokens(p).flatMap((w) => q.map((x) => editDistance(x, w))));
  return { matches: [], nearest: [...people].sort((a, b) => score(a) - score(b)).slice(0, 3) };
}

/* ------------------------------------------------------------------ items */

const CODE = /\b([A-Z]{2,4})[-\s]?(\d{3}[A-Z]?)\b/;
/** A room code: "Room 12", "Hall B", "Lab-3", "A-12" (never a word: "lab report" is not a room). */
const ROOM = /\b(?:room|rm\.?|hall|lab|venue)\s*[:#-]?\s*([A-Z]-?\d{0,4}[A-Z]?|\d{1,4}[A-Z]?)\b/i;

export function kindOf(text: string): ItemKind {
  const t = text.toLowerCase();
  if (/\b(?:exam|exams|midterm|mid-term|mid term|final|finals|paper|viva)\b/.test(t)) return "exam";
  if (/\bquiz(?:zes)?\b/.test(t)) return "quiz";
  if (/\b(?:assignment|homework|submission|project|report|lab report|presentation|deadline)\b/.test(t)) return "assignment";
  if (/\b(?:class|lecture|lab|tutorial|session)\b/.test(t)) return "class";
  return "other";
}

/**
 * Who each item belongs to, from the item itself (a grid cell, its line) or the section it sits in ("Instructor:
 * Dr. Ahmed" above a table, a page per teacher). Reads the stored text only: no OCR again.
 */
function sectionPeople(text: string): Array<{ at: number; person: string }> {
  const lines = text.split("\n");
  const out: Array<{ at: number; person: string }> = [];
  let offset = 0;
  for (const line of lines) {
    const p = personIn(line);
    // A heading names someone and little else (no time on it): it applies to what follows.
    if (p && !/\d{1,2}[:.]\d{2}|\b\d{1,2}\s*(?:am|pm)\b/i.test(line)) out.push({ at: offset, person: p });
    offset += line.length + 1;
  }
  return out;
}

function personFor(source: string, own: string | null, text: string, sections: Array<{ at: number; person: string }>): string | null {
  // The item's own line first (it keeps OCR'd names whole); then what the reader found (a grid cell); then the section.
  const inLine = personIn(source);
  if (inLine) return inLine;
  if (own) return tidyName(own);
  const at = text.indexOf(source.slice(0, 40));
  if (at < 0) return null;
  const before = sections.filter((s) => s.at <= at);
  return before.length ? before[before.length - 1].person : null;
}

/** Structured fields for every item (pure; the same document always gives the same fields). */
export function enrichItems(text: string, deadlines: ExtractedDeadline[], schedules: ExtractedSchedule[]): { deadlines: Array<ExtractedDeadline & { meta: ItemMeta }>; schedules: Array<ExtractedSchedule & { meta: ItemMeta }> } {
  const sections = sectionPeople(text);
  const courseOf = (title: string, source: string) => {
    const m = CODE.exec(`${title} ${source}`);
    return m ? `${m[1]}-${m[2]}` : null;
  };
  // A course's code from its classes ("Data Structures (CS-201)"), for the exams and assignments of that course.
  const codes = new Map<string, string>();
  for (const s of schedules) {
    const code = courseOf(s.title, s.source);
    // The course name is what comes before its code, room or teacher: "Technical Writing (EN-102) Hall B".
    const name = s.title.split(/\s*(?:\(|\s-\s|–)\s*/)[0].replace(/\b[A-Z]{2,4}[-\s]?\d{3}[A-Z]?\b/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    if (code && name.length >= 4) codes.set(name, code);
  }
  const codeByName = (title: string) => [...codes].find(([name]) => title.toLowerCase().includes(name))?.[1] ?? null;
  return {
    deadlines: deadlines.map((d) => ({
      ...d,
      meta: {
        person: personFor(d.source, null, text, sections),
        courseCode: courseOf(d.title, d.source) ?? codeByName(d.title),
        course: d.title,
        kind: kindOf(`${d.activity} ${d.title}`),
        days: d.date ? [weekdayOfYmd(d.date)] : [],
        room: ROOM.exec(d.source)?.[1] ?? null,
      },
    })),
    schedules: schedules.map((s) => ({
      ...s,
      meta: {
        person: personFor(s.source, s.instructor, text, sections),
        courseCode: courseOf(s.title, s.source),
        course: s.title,
        kind: kindOf(s.title) === "exam" ? "exam" : "class",
        days: s.daysOfWeek,
        room: s.room ?? ROOM.exec(s.source)?.[1] ?? null,
      },
    })),
  };
}

/* ------------------------------------------------------------------ the instruction */

export const filterSchema = z.object({
  person: z.string().min(1).max(60).nullable().default(null),
  course: z.string().min(1).max(60).nullable().default(null),
  days: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  kind: z.array(z.enum(["class", "exam", "quiz", "assignment", "other"])).max(5).default([]),
  dateRange: z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).nullable().default(null),
  roomOrPlace: z.string().min(1).max(40).nullable().default(null),
  asRoutines: z.boolean().default(false),
});
export type DocFilter = z.infer<typeof filterSchema>;

const KIND_WORDS: Array<[RegExp, ItemKind]> = [
  [/\b(?:exams?|midterms?|mid-terms?|finals?|papers?|vivas?)\b/i, "exam"],
  [/\bquiz(?:zes)?\b/i, "quiz"],
  [/\b(?:assignments?|homework|submissions?|projects?|deadlines?)\b/i, "assignment"],
  [/\b(?:class(?:es)?|lectures?|labs?|tutorials?|timetable)\b/i, "class"],
];
/** Words that only frame the request. */
const FRAME = new Set("only just show me my the a an all of for from with by taught and or in on at please give list keep need want add items item things stuff schedule what i do from this document".split(" "));

export type InstructionRead = {
  filter: DocFilter;
  /** What was read, in words ("Dr. Ahmed · exams · Mondays"). */
  understood: string[];
  /** Words the rules could not place. */
  leftover: string[];
};

const DAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

/** Rules: kinds, days, dates, course codes, rooms, people (titled, possessive, "by X"), names found in the document. */
export function readInstruction(instruction: string, people: string[], courses: string[], todayYmd: string): InstructionRead {
  const filter: DocFilter = filterSchema.parse({});
  const understood: string[] = [];
  let rest = ` ${instruction.replace(/[?!.]+$/, "")} `;
  const take = (re: RegExp) => {
    const m = re.exec(rest);
    if (m) rest = rest.replace(m[0], " ");
    return m;
  };
  for (const [re, kind] of KIND_WORDS) if (take(re)) filter.kind.push(kind);
  if (filter.kind.length) understood.push(filter.kind.map((k) => `${k === "class" ? "classes" : k === "quiz" ? "quizzes" : `${k}s`}`).join(" and "));
  if (take(/\b(?:as|into)\s+(?:a\s+)?(?:routines?|my timetable)\b|\b(?:recurring|every week)\b/i)) {
    filter.asRoutines = true;
    understood.push("as routines");
  }
  const code = take(CODE);
  if (code) {
    filter.course = `${code[1].toUpperCase()}-${code[2].toUpperCase()}`;
    understood.push(filter.course);
  }
  const room = take(ROOM);
  if (room) {
    filter.roomOrPlace = room[1];
    understood.push(`room ${room[1]}`);
  }
  const days = extractWeekdays(rest);
  if (days?.length && /\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*s\b|\bweekdays?\b|\bweekends?\b|\band\b|\bon\b/i.test(rest)) {
    filter.days = days;
    understood.push(days.length === 7 ? "every day" : days.map((d) => DAY_NAMES[d]).join(" and "));
    rest = rest.replace(/\b(?:mon|tues|wednes|thurs|fri|satur|sun)(?:day)?s?\b|\bweekdays?\b|\bweekends?\b/gi, " ");
  } else if (RANGE_WORD.test(rest) || /\b(?:today|tomorrow|\d{1,2}(?:st|nd|rd|th)|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(rest)) {
    const r = resolveRange(rest, parseCtx({ now: new Date(`${todayYmd}T12:00:00Z`), tz: "UTC" } as never));
    if (r && r !== "unknown") {
      filter.dateRange = { from: r.from, to: r.to };
      understood.push(r.label);
      rest = rest.replace(/\b(?:this|next|coming|the|before|after|until|till|by|in)\b|\b(?:week|weekend|month|days?|today|tomorrow|\d{1,2}(?:st|nd|rd|th)?)\b/gi, " ");
    }
  }
  // A titled name, a possessive ("Ahmed's"), or "by / with / of / taught by X".
  const titled = take(new RegExp(`\\b(?:${TITLES})\\.?\\s+[a-z][a-z'-]+(?:\\s+(?!(?:classes|class|exams?|quiz|lectures?|on|and|only)\\b)[a-z][a-z'-]+)?`, "i"));
  const possessive = !titled && take(/\b([a-z][a-z-]{2,})['’]s\b/i);
  const byName = !titled && !possessive && take(/\b(?:taught by|by|with|of|from)\s+([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+)?)/i);
  const named = titled?.[0] ?? (possessive ? possessive[1] : null) ?? (byName ? byName[1] : null);
  if (named) filter.person = named.replace(/['’]s\b/gi, "").trim();
  // Words left: a name of someone in the document, or a course title.
  const words = rest.toLowerCase().replace(/['’]s\b/g, "").split(/[^a-z0-9-]+/).filter((w) => w && !FRAME.has(w));
  const leftover: string[] = [];
  for (const w of words) {
    if (!filter.person && w.length >= 3 && people.some((p) => nameMatches(w, p))) {
      filter.person = w;
      continue;
    }
    if (filter.person && nameTokens(filter.person).includes(w)) continue;
    // The next word of the same person's name ("Sara" then "Malik").
    if (filter.person && w.length >= 3 && people.some((p) => nameMatches(`${filter.person} ${w}`, p))) {
      filter.person = `${filter.person} ${w}`;
      continue;
    }
    const course = courses.find((c) => c.toLowerCase().split(/\s+/).some((x) => x.length >= 4 && sameWord(x, w)));
    if (!filter.course && course && w.length >= 4) {
      filter.course = w;
      continue;
    }
    if (filter.course && filter.course.toLowerCase().includes(w)) continue;
    leftover.push(w);
  }
  if (filter.person) understood.unshift(filter.person);
  if (filter.course && !code) understood.push(`course "${filter.course}"`);
  return { filter, understood, leftover };
}

/** The local model, only when the rules leave words they can't place. Ollama only; the text is not masked. */
export async function modelInstruction(instruction: string, todayYmd: string, timeoutMs = 15000): Promise<DocFilter | null> {
  const raw = await getAi().json(
    [
      {
        role: "system",
        content: `A student uploaded a document (timetable, date sheet, course outline) and says which items they want from it. Return JSON with: person (a teacher's name as written, or null), course (a course name or code, or null), days (0=Sunday … 6=Saturday, [] for any), kind (any of class, exam, quiz, assignment, other; [] for any), dateRange ({"from","to"} as YYYY-MM-DD, or null; today is ${todayYmd}), roomOrPlace (or null), asRoutines (true if they want weekly routines). Only what the request says; null or [] otherwise.`,
      },
      { role: "user", content: instruction.slice(0, 300) },
    ],
    // A null for a list or a yes/no is read as empty / false (the model writes null for "not said"); the rest is strict.
    z.preprocess((v) => (v && typeof v === "object" ? { ...v, days: (v as { days?: unknown }).days ?? [], kind: (v as { kind?: unknown }).kind ?? [], asRoutines: (v as { asRoutines?: unknown }).asRoutines ?? false } : v), filterSchema),
    { providers: ["ollama"], maxTokens: 150, timeoutMs, json: true },
  );
  const parsed = raw ? filterSchema.safeParse(raw) : null;
  return parsed?.success ? parsed.data : null;
}

/* ------------------------------------------------------------------ applying it */

export type FilterResult = {
  instruction: string;
  understood: string[];
  /** applied: items filtered. ask_person: several people match (options). no_person: none does (nearest). not_understood: some words weren't placed. */
  status: "applied" | "ask_person" | "no_person" | "not_understood";
  filter: DocFilter;
  options?: string[];
  nearest?: string[];
  leftover?: string[];
  /** The resolved person (one of the document's people) when the filter names one. */
  person?: string | null;
  shown: number;
  total: number;
};

type Item = { meta?: ItemMeta; date?: string | null };

function itemMatches(item: Item, f: DocFilter, person: string | null): boolean {
  const m = item.meta;
  if (!m) return false;
  if (person && !(m.person && samePerson(m.person, person))) return false;
  if (f.course) {
    const want = f.course.toLowerCase().replace(/[-\s]/g, "");
    const has = `${m.courseCode ?? ""} ${m.course ?? ""}`.toLowerCase().replace(/[-\s]/g, "");
    if (!has.includes(want)) return false;
  }
  if (f.kind.length && !f.kind.includes(m.kind)) return false;
  if (f.days.length && !m.days.some((d) => f.days.includes(d))) return false;
  if (f.roomOrPlace && !(m.room ?? "").toLowerCase().includes(f.roomOrPlace.toLowerCase())) return false;
  if (f.dateRange) {
    if (item.date) {
      if (item.date < f.dateRange.from || item.date > f.dateRange.to) return false;
    } else {
      // A weekly class falls in the range when one of its days does.
      const inRange = new Set<number>();
      for (let d = f.dateRange.from, i = 0; d <= f.dateRange.to && i < 7; d = addDaysYmd(d, 1), i += 1) inRange.add(weekdayOfYmd(d));
      if (!m.days.some((d) => inRange.has(d))) return false;
    }
  }
  return true;
}

/**
 * The instruction over the stored items: which match (`matches`), or the question to ask first. With a question
 * pending nothing matches, so nothing is created; the review shows everything until the user answers.
 */
export function applyInstruction(read: InstructionRead, items: Item[], people: string[], chosenPerson?: string | null): { result: Omit<FilterResult, "instruction">; matches: boolean[] } {
  const f = read.filter;
  const none = items.map(() => false);
  let person: string | null = null;
  if (chosenPerson) person = people.find((p) => samePerson(p, chosenPerson)) ?? chosenPerson;
  else if (f.person) {
    const m = matchPerson(f.person, people);
    if (m.matches.length > 1) return { result: { status: "ask_person", understood: read.understood, filter: f, options: m.matches, shown: 0, total: items.length }, matches: none };
    if (!m.matches.length) return { result: { status: "no_person", understood: read.understood, filter: f, nearest: m.nearest, shown: 0, total: items.length }, matches: none };
    person = m.matches[0];
  }
  if (read.leftover.length) return { result: { status: "not_understood", understood: read.understood, filter: f, leftover: read.leftover, person, shown: 0, total: items.length }, matches: none };
  const matches = items.map((i) => itemMatches(i, f, person));
  const understood = person ? [person, ...read.understood.filter((u) => u !== f.person)] : read.understood;
  return { result: { status: "applied", understood, filter: f, person, shown: matches.filter(Boolean).length, total: items.length }, matches };
}

/**
 * The model's reading of an instruction the rules couldn't fully place. It is taken only when it agrees with what the
 * rules did read (no contradiction): then the unplaced words were phrasing, and the model fills any field the rules
 * left empty. A contradiction keeps the question for the user.
 */
export function withModel(read: InstructionRead, model: DocFilter | null): InstructionRead {
  if (!model) return read;
  const r = read.filter;
  const agrees =
    (!r.person || !model.person || nameMatches(r.person, model.person) || nameMatches(model.person, r.person)) &&
    (!r.course || !model.course || model.course.toLowerCase().includes(r.course.toLowerCase()) || r.course.toLowerCase().includes(model.course.toLowerCase())) &&
    (!r.days.length || !model.days.length || model.days.every((d) => r.days.includes(d))) &&
    (!r.kind.length || !model.kind.length || model.kind.every((k) => r.kind.includes(k))) &&
    (!r.roomOrPlace || !model.roomOrPlace || model.roomOrPlace.toLowerCase().includes(r.roomOrPlace.toLowerCase()) || r.roomOrPlace.toLowerCase().includes(model.roomOrPlace.toLowerCase()));
  if (!agrees) return read;
  const f = { ...r };
  const added: string[] = [];
  if (!f.person && model.person) (f.person = model.person), added.push(model.person);
  if (!f.course && model.course) (f.course = model.course), added.push(`course "${model.course}"`);
  if (!f.days.length && model.days.length) (f.days = model.days), added.push(model.days.map((d) => DAY_NAMES[d]).join(" and "));
  if (!f.kind.length && model.kind.length) (f.kind = model.kind), added.push(model.kind.join(" and "));
  if (!f.dateRange && model.dateRange) (f.dateRange = model.dateRange), added.push(`${model.dateRange.from} to ${model.dateRange.to}`);
  if (!f.roomOrPlace && model.roomOrPlace) (f.roomOrPlace = model.roomOrPlace), added.push(`room ${model.roomOrPlace}`);
  const anything = f.person || f.course || f.days.length || f.kind.length || f.dateRange || f.roomOrPlace;
  return anything ? { filter: f, understood: [...read.understood, ...added], leftover: [] } : read;
}
