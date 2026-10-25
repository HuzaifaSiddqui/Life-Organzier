import { Priority, TaskStatus, type Routine, type Task } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../config/db.js";
import { normalizeSpelled } from "../../lib/spelled.js";
import { fuzzySimilarity } from "../../lib/text.js";
import { addDaysYmd, startOfLocalDay } from "../../lib/time.js";
import { normalize } from "../assistant/queries.js";

/**
 * Find tasks and routines by what they are about (FR: "is there any task related to KFC"). Searches every
 * place a word can live: title, notes, tags, category, subtasks, the place's name and address, and routine
 * title and location. Rules only; the router may fill the same filter when AI is on.
 */
export const findFilterSchema = z.object({
  terms: z.array(z.string().trim().min(1).max(60)).min(1).max(6),
  status: z.enum(["active", "completed", "all"]).optional(),
  dateRange: z.enum(["today", "tomorrow", "week", "overdue"]).optional(),
  priority: z.nativeEnum(Priority).optional(),
  tag: z.string().trim().min(1).max(40).optional(),
  place: z.string().trim().min(1).max(80).optional(),
});
export type FindFilter = z.infer<typeof findFilterSchema>;

export type FieldName = "title" | "notes" | "tags" | "category" | "subtask" | "location";
export type Field = { name: FieldName; text: string };

/** Match strength, best first. A term counts once, at its best match. */
export const MATCH = { exact: 4, substring: 3, fuzzy: 2, phonetic: 1 } as const;
const FUZZY_MIN = 0.75;

/** Lower case, Urdu letters unified, punctuation gone, spelled letters joined ("K.F.C" → "kfc"). */
export function searchText(s: string): string {
  return normalize(normalizeSpelled(s));
}

/** American Soundex: "Kentuky" and "Kentucky" share K532; "KFC" (K120) does not. Latin words of 3+ letters only. */
export function soundex(word: string): string | null {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length < 3) return null;
  const code: Record<string, string> = { b: "1", f: "1", p: "1", v: "1", c: "2", g: "2", j: "2", k: "2", q: "2", s: "2", x: "2", z: "2", d: "3", t: "3", l: "4", m: "5", n: "5", r: "6" };
  let out = w[0].toUpperCase();
  let prev = code[w[0]] ?? "";
  for (const ch of w.slice(1)) {
    const c = code[ch] ?? "";
    if (c && c !== prev) out += c;
    if (ch !== "h" && ch !== "w") prev = c;
  }
  return (out + "000").slice(0, 4);
}

/**
 * Best match of one term in one field: 4 exact word or phrase, 3 substring, 2 fuzzy word, 1 same sound, 0 none.
 * A substring counts at a word start ("phys" → "physics"), and inside a word only for terms of 5+ letters
 * ("burger" → "cheeseburger"), so "art" never matches "start" or "party". Digits after letters start a word
 * ("461" → "CSC461").
 */
export function matchStrength(term: string, field: string): number {
  const t = searchText(term);
  const f = searchText(field);
  if (!t || !f) return 0;
  if (` ${f} `.includes(` ${t} `)) return MATCH.exact;
  // A switch between letters and digits is a word start too: "461" in "csc461".
  const starts = ` ${f.replace(/(\p{L})(?=\p{N})|(\p{N})(?=\p{L})/gu, "$1$2 ")}`;
  if (t.length >= 3 && (starts.includes(` ${t}`) || (t.length >= 5 && f.includes(t)))) return MATCH.substring;
  const words = f.split(" ");
  if (words.some((w) => w.length >= 3 && fuzzySimilarity(t, w) >= FUZZY_MIN)) return MATCH.fuzzy;
  const key = !t.includes(" ") ? soundex(t) : null;
  if (key && t.length >= 4 && words.some((w) => soundex(w) === key)) return MATCH.phonetic;
  return 0;
}

/**
 * Every term must match somewhere. Score = sum of each term's best strength; matchedIn = the fields where
 * a term matched at its best (in field order).
 */
export function scoreFields(terms: string[], fields: Field[]): { score: number; matchedIn: FieldName[] } | null {
  let score = 0;
  const matchedIn = new Set<FieldName>();
  for (const term of terms) {
    let best = 0;
    let where: FieldName[] = [];
    for (const field of fields) {
      const s = matchStrength(term, field.text);
      if (s > best) {
        best = s;
        where = [field.name];
      } else if (s && s === best && !where.includes(field.name)) where.push(field.name);
    }
    if (!best) return null;
    score += best;
    for (const w of where) matchedIn.add(w);
  }
  const order: FieldName[] = ["title", "location", "notes", "subtask", "tags", "category"];
  return { score, matchedIn: order.filter((n) => matchedIn.has(n)) };
}

/** How close an item comes to the terms (for "did you mean"), 0..1. */
function closeness(terms: string[], fields: Field[]): number {
  const q = searchText(terms.join(" "));
  return Math.max(0, ...fields.flatMap((f) => [fuzzySimilarity(q, searchText(f.text)), ...searchText(f.text).split(" ").map((w) => fuzzySimilarity(q, w))]));
}

type TaskRow = Task & { subtasks: Array<{ title: string }>; locations: Array<{ savedLocation: { name: string; displayAddress: string | null } }> };

function taskFields(t: TaskRow): Field[] {
  const tags = Array.isArray(t.tags) ? (t.tags as unknown[]).map(String) : [];
  return [
    { name: "title", text: t.title },
    ...(t.description ? [{ name: "notes" as const, text: t.description }] : []),
    ...(tags.length ? [{ name: "tags" as const, text: tags.join(" ") }] : []),
    ...(t.category ? [{ name: "category" as const, text: t.category }] : []),
    ...t.subtasks.map((s) => ({ name: "subtask" as const, text: s.title })),
    ...t.locations.flatMap((l) => [{ name: "location" as const, text: l.savedLocation.name }, ...(l.savedLocation.displayAddress ? [{ name: "location" as const, text: l.savedLocation.displayAddress }] : [])]),
    ...(t.locationContext ? [{ name: "location" as const, text: t.locationContext }] : []),
  ];
}

function routineFields(r: Routine): Field[] {
  return [
    { name: "title", text: r.title },
    ...(r.location ? [{ name: "location" as const, text: r.location }] : []),
    ...(r.locationContext ? [{ name: "location" as const, text: r.locationContext }] : []),
  ];
}

export type Found = { kind: "task"; task: Task; score: number; matchedIn: FieldName[] } | { kind: "routine"; routine: Routine; score: number; matchedIn: FieldName[] };
export type FindResult = { items: Found[]; closest: Array<{ kind: "task"; task: Task } | { kind: "routine"; routine: Routine }> };

export const FIND_LIMIT = 8;
/** "Closest" suggestions only when they are actually close; otherwise just "nothing found". */
const CLOSEST_MIN = 0.35;

/** Tasks and routines matching the filter, best first (score, then due date), at most FIND_LIMIT. */
export async function findItems(userId: string, filter: FindFilter, opts: { tz: string; now: Date; todayYmd: string }): Promise<FindResult> {
  const statuses = filter.status === "completed" ? [TaskStatus.COMPLETED] : filter.status === "all" ? [TaskStatus.PENDING, TaskStatus.IN_PROGRESS, TaskStatus.COMPLETED] : [TaskStatus.PENDING, TaskStatus.IN_PROGRESS];
  const due = dueBounds(filter.dateRange, opts);
  const tasks = (await prisma.task.findMany({
    where: { userId, parentTaskId: null, archived: false, status: { in: statuses }, ...(filter.priority ? { priority: filter.priority } : {}), ...(due ? { dueAt: due } : {}) },
    include: { subtasks: { select: { title: true }, where: { status: { not: TaskStatus.DELETED } } }, locations: { include: { savedLocation: { select: { name: true, displayAddress: true } } } } },
    take: 500,
  })) as TaskRow[];
  // Routines have no due date or priority: only when the question doesn't filter on those.
  const routines = due || filter.priority || filter.status === "completed" ? [] : await prisma.routine.findMany({ where: { userId, active: true }, take: 200 });
  const terms = filter.terms;
  const items: Found[] = [];
  const near: Array<{ c: number; item: FindResult["closest"][number] }> = [];
  for (const t of tasks) {
    const fields = taskFields(t);
    if (filter.tag && !fields.some((f) => f.name === "tags" && searchText(f.text).split(" ").includes(searchText(filter.tag as string)))) continue;
    const placeFields = fields.filter((f) => f.name === "location");
    if (filter.place && !scoreFields([filter.place], placeFields)) continue;
    const s = scoreFields(terms, fields);
    if (s) items.push({ kind: "task", task: t, ...s });
    else near.push({ c: closeness(terms, fields), item: { kind: "task", task: t } });
  }
  for (const r of routines) {
    const fields = routineFields(r);
    if (filter.tag) continue;
    if (filter.place && !scoreFields([filter.place], fields.filter((f) => f.name === "location"))) continue;
    const s = scoreFields(terms, fields);
    if (s) items.push({ kind: "routine", routine: r, ...s });
    else near.push({ c: closeness(terms, fields), item: { kind: "routine", routine: r } });
  }
  const dueOf = (f: Found) => (f.kind === "task" ? (f.task.dueAt?.getTime() ?? Infinity) : Infinity);
  items.sort((a, b) => b.score - a.score || dueOf(a) - dueOf(b));
  const closest = items.length ? [] : near.filter((n) => n.c >= CLOSEST_MIN).sort((a, b) => b.c - a.c).slice(0, 2).map((n) => n.item);
  return { items: items.slice(0, FIND_LIMIT), closest };
}

function dueBounds(range: FindFilter["dateRange"], o: { tz: string; now: Date; todayYmd: string }): { gte?: Date; lt: Date } | null {
  const day = (ymd: string) => startOfLocalDay(ymd, o.tz);
  switch (range) {
    case "today":
      return { gte: day(o.todayYmd), lt: day(addDaysYmd(o.todayYmd, 1)) };
    case "tomorrow":
      return { gte: day(addDaysYmd(o.todayYmd, 1)), lt: day(addDaysYmd(o.todayYmd, 2)) };
    case "week":
      return { gte: day(o.todayYmd), lt: day(addDaysYmd(o.todayYmd, 7)) };
    case "overdue":
      return { lt: o.now };
    default:
      return null;
  }
}
