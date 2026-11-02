import { isWhatsapp } from "../channel.js";
import { chatFixesOn } from "../chatFixes.js";
import type { Priority } from "@prisma/client";
import { normalizeSpelled } from "../../../lib/spelled.js";
import { truncate } from "../../../lib/text.js";
import { addDaysYmd, weekdayOfYmd } from "../../../lib/time.js";
import { serializeTask } from "../../tasks/taskService.js";
import { FIND_LIMIT, findFilterSchema, findItems, type FindFilter, type Found } from "../../search/searchService.js";
import { dueLabel, focusOn, type Out, type Turn } from "../dialogue.js";
import { extractEntities } from "../entities.js";
import type { Card } from "../types.js";
import type { Command, CommandArgs, ParseCtx } from "./types.js";

/**
 * "Is there any task related to KFC", "anything with Kalma Chowk", "KFC wala kaam". English and Roman Urdu only
 * (Urdu-script questions are planned after the deadline). Only when the question names something to look for;
 * a plain "what's due today" stays with the task list.
 */

const NOUN = "(?:tasks?|things?|items?|reminders?|routines?|todos?|to-dos?|kaam|kam)";
const LINK = "(?:related to|relating to|regarding|about|concerning|involving|mentioning|that mention|with|for|on|at|from)";
const ASKING = /\?|^(?:is|are|do|does|did|have|has|what|which|show|list|find|search|look|any|anything|kya|koi)\b|\b(?:is there|are there|do i have|have i got|any|anything|kya|koi)\b|^(?:please\s+)?(?:get|give|tell|show|bring|pull up)\s+me\b/i;
/** Doing something to a task is a command, not a search ("add a task for KFC tomorrow", "mark the KFC task done"). */
const DOING = /^(?:please\s+)?(?:add|create|new|remind|set|make|schedule|mark|complete|finish|delete|remove|cancel|move|change|rename|update|edit|start|split|break|tag|untag|pause|resume|skip|put|push|postpone)\b/i;

/**
 * `standalone`: Urdu-style "KFC wala kaam" asks by itself, but only when nothing but question words follow
 * ("…kaam hai?", "…koi task batao"); "KFC wala kaam kal karna hai" is a new task.
 */
type Pattern = { re: RegExp; place?: boolean; standalone?: boolean };
const ASK_TAIL = /^(?:\s+(?:hai|hain|he|kya|koi|batao|btao|dikhao|bata\s*do|please|plz))*\s*$/i;
const PATTERNS: Pattern[] = [
  // "tasks about Walmart", "reminders regarding the visa": a plural list noun + topic asks by itself.
  { re: /^(?:(?:any|all|my|the)\s+)?(?:tasks|things|items|reminders|routines|todos|to-dos)\s+(?:related to|relating to|regarding|about|concerning|involving|mentioning|that mention)\s+(.+)$/i, standalone: true },
  { re: new RegExp(`\\b(?:any|a|some|all|the|my)?\\s*${NOUN}\\s+${LINK}\\s+(.+)$`, "i") },
  { re: /\b(?:anything|something|stuff)\s+(?:with|about|related to|regarding|for|at|on)\s+(.+)$/i },
  { re: /\bwhat (?:do|did|else do) (?:i|we) have (?:at|in|near|on)\s+(.+)$/i, place: true },
  { re: /^(?:find|search(?:\s+for)?|look\s+(?:for|up))\s+(?:my\s+|the\s+)?(?:tasks?\s+)?(?:about|for|with|related to)?\s*(.+)$/i },
  { re: new RegExp(`\\b(?:any|my|the|all)\\s+(.+?)\\s+${NOUN}\\b`, "i") },
  // Roman Urdu: "KFC wala kaam", "KFC se related koi task", "KFC ke bare mein koi kaam", "KFC ka koi kaam"
  { re: /^(.+?)\s+(?:wala|wali|wale|waala|waali|waale)\s+(?:koi\s+)?(?:kaam|kam|task|tasks)\b/i, standalone: true },
  { re: /^(.+?)\s+(?:se|say)\s+(?:related|mutaliq|mutalliq|mutalik)\s+(?:koi\s+)?(?:kaam|kam|task|tasks)\b/i, standalone: true },
  { re: /^(.+?)\s+ke\s+(?:bare|baare|barey)\s+(?:mein|main|me|mai)\s+(?:koi\s+)?(?:kaam|kam|task|tasks)\b/i, standalone: true },
  { re: /^(.+?)\s+ka\s+koi\s+(?:kaam|kam|task)\b/i, standalone: true },
];

/** Words that shape the question, not what it is about. */
const NOT_A_TERM = new Set(
  ("is there are any a an the my some all of to for with and or about related relating regarding task tasks thing things item items reminder reminders routine routines todo todos " +
    "anything something stuff do does i have has got please today tonight tomorrow this week overdue late missed done completed finished pending open urgent important high low priority " +
    "due deadline deadlines scheduled planned " +
    "koi ka ki ke kaam kam hai hain kya mera meri mere wala wali wale aaj kal mein se").split(" "),
);

/** "overdue", "this week", or the day entities.ts reads ("today", "kal") when it is today or tomorrow. */
/** Days asked about, inclusive (CHAT_FIXES_V2). */
export type DayRange = { from: string; to: string; label: string };

/** A word that asks about a span of time; when none of the rules below reads it, the user is asked which days. */
const RANGE_WORD = /\b(?:week|weekend|month|soon|later|upcoming|coming|next few|few days|before|after|until|till|between|from|by)\b/i;

/**
 * The days a question asks about: next week, this/next weekend, after the weekend, this/next month, by / until /
 * before a day, or one day (weekday names, "the 12th", dates, today / tomorrow). "unknown" = it names a span this
 * can't read (ask, never answer with today); null = no time in the question.
 */
export function resolveRange(text: string, ctx: ParseCtx): DayRange | "unknown" | null {
  const t = text.toLowerCase();
  const today = ctx.todayYmd;
  const dow = weekdayOfYmd(today); // 0 = Sunday
  const plus = (n: number) => addDaysYmd(today, n);
  const thisSat = dow === 0 ? plus(-1) : plus(6 - dow);
  const nextMon = plus(dow === 0 ? 1 : 8 - dow);
  if (/\bnext week\b/.test(t)) return { from: nextMon, to: addDaysYmd(nextMon, 6), label: "Next week" };
  if (/\bnext weekend\b/.test(t)) return { from: addDaysYmd(thisSat, 7), to: addDaysYmd(thisSat, 8), label: "Next weekend" };
  if (/\bafter the weekend\b|\bafter weekend\b/.test(t)) return { from: nextMon, to: addDaysYmd(nextMon, 6), label: "After the weekend" };
  if (/\b(?:this |the )?weekend\b/.test(t)) return { from: dow === 0 ? today : thisSat, to: dow === 0 ? today : addDaysYmd(thisSat, 1), label: "This weekend" };
  if (/\b(?:this week|is hafte|is haftay)\b/.test(t)) return { from: today, to: plus(6), label: "This week" };
  const [y, mo] = today.split("-").map(Number);
  const lastOf = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
  if (/\bthis month\b/.test(t)) return { from: today, to: lastOf(y, mo), label: "This month" };
  if (/\bnext month\b/.test(t)) {
    const ny = mo === 12 ? y + 1 : y;
    const nm = mo === 12 ? 1 : mo + 1;
    return { from: `${ny}-${String(nm).padStart(2, "0")}-01`, to: lastOf(ny, nm), label: "Next month" };
  }
  const e = extractEntities(text, ctx.opts);
  const ymd = e.date && !e.date.fuzzy ? e.date.ymd : null;
  if (ymd && /\b(?:by|until|till|before)\b/.test(t)) {
    const to = /\bbefore\b/.test(t) ? addDaysYmd(ymd, -1) : ymd;
    return to >= today ? { from: today, to, label: `Until ${ymd === to ? e.date!.text : `before ${e.date!.text}`}` } : "unknown";
  }
  if (ymd) return { from: ymd, to: ymd, label: ymd === today ? "Today" : ymd === plus(1) ? "Tomorrow" : e.date!.text.replace(/^on\s+/i, "") };
  return RANGE_WORD.test(t) ? "unknown" : null;
}

export function findDateRange(text: string, ctx: ParseCtx): FindFilter["dateRange"] {
  if (chatFixesOn()) {
    const r = resolveRange(text, ctx);
    if (r && r !== "unknown") return r.from === ctx.todayYmd && r.to === ctx.todayYmd ? "today" : { from: r.from, to: r.to };
  }
  const lower = text.toLowerCase();
  if (/\b(?:overdue|late|missed)\b/.test(lower)) return "overdue";
  if (/\b(?:this week|is hafte|is haftay)\b/.test(lower)) return "week";
  const ymd = extractEntities(text, ctx.opts).date?.ymd;
  return ymd === ctx.todayYmd ? "today" : ymd === addDaysYmd(ctx.todayYmd, 1) ? "tomorrow" : undefined;
}

export function parseFindQuery(text: string, ctx: ParseCtx): FindFilter | null {
  const said = normalizeSpelled(text).trim().replace(/[?؟.!]+$/, "");
  if (!said || DOING.test(said)) return null;
  const asking = ASKING.test(said);
  for (const p of PATTERNS) {
    const m = p.re.exec(said);
    if (!m) continue;
    if (!(p.standalone ? asking || ASK_TAIL.test(said.slice(m.index + m[0].length)) : asking)) continue;
    const filter = filterFrom(said, m[1], ctx, p.place);
    if (filter) return filter;
  }
  return null;
}

/** CHAT_FIXES_V2 (F): words that rank or time a question, not what it is about ("my most urgent task right now"). */
const FILLER = new Set(["most", "least", "right", "now", "latest", "current", "currently", "top", "main", "biggest", "first"]);

function filterFrom(said: string, about: string, ctx: ParseCtx, place?: boolean): FindFilter | null {
  const lower = said.toLowerCase();
  const tag = /#([\p{L}\p{N}_-]{1,40})/u.exec(about)?.[1]?.toLowerCase();
  // Dates come from entities.ts; only the words left over are what the question is about.
  const e = extractEntities(about.replace(/#[\p{L}\p{N}_-]+/gu, " "), ctx.opts);
  const terms = e.residual
    .toLowerCase()
    .split(/[\s,]+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((w) => w.length >= 2 && !NOT_A_TERM.has(w) && !(chatFixesOn() && FILLER.has(w)));
  if (!terms.length && !tag) return null;
  const range = findDateRange(said, ctx);
  const priority: Priority | undefined = /\burgent\b/.test(lower) ? "URGENT" : /\b(?:high priority|important)\b/.test(lower) ? "HIGH" : /\blow priority\b/.test(lower) ? "LOW" : undefined;
  const status = /\b(?:done|completed|finished|ho gaya|mukammal)\b/.test(lower) ? "completed" : /\b(?:all|sab|sare|tamam)\b/.test(lower) ? "all" : undefined;
  const parsed = findFilterSchema.safeParse({
    terms: terms.length ? terms : [tag],
    ...(status ? { status } : {}),
    ...(range ? { dateRange: range } : {}),
    ...(priority ? { priority } : {}),
    ...(tag ? { tag } : {}),
    ...(place && terms.length ? { place: terms.join(" ") } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/* ------------------------------------------------------------------ reply */

const FIELD_LABEL: Record<string, { en: string; ur: string }> = {
  title: { en: "title", ur: "عنوان" },
  location: { en: "location", ur: "مقام" },
  notes: { en: "notes", ur: "نوٹس" },
  subtask: { en: "subtask", ur: "ذیلی کام" },
  tags: { en: "tags", ur: "ٹیگ" },
  category: { en: "category", ur: "زمرہ" },
};

const TEXT = {
  en: {
    found: (n: number, q: string) => `Found ${n} matching "${q}":`,
    none: (q: string) => `I couldn't find a task or routine about "${q}".`,
    closest: (titles: string) => `Closest: ${titles}.`,
    matchedIn: "matched in",
    routine: "routine",
    noDue: "no due date",
  },
  ur: {
    found: (n: number, q: string) => `"${q}" سے ملتے ${n} کام:`,
    none: (q: string) => `"${q}" کے بارے میں کوئی کام یا روٹین نہیں ملی۔`,
    closest: (titles: string) => `قریب ترین: ${titles}۔`,
    matchedIn: "ملا",
    routine: "روٹین",
    noDue: "کوئی تاریخ نہیں",
  },
};

export async function findReply(turn: Turn, filter: FindFilter): Promise<Out> {
  const lang = turn.settings.language === "ur" ? "ur" : "en";
  const T = TEXT[lang];
  const q = filter.terms.join(" ");
  const { items, closest } = await findItems(turn.user.id, filter, { tz: turn.tz, now: turn.now, todayYmd: turn.todayYmd });
  if (!items.length) {
    const near = closest.map((c) => `"${c.kind === "task" ? c.task.title : c.routine.title}"`).join(", ");
    return {
      content: [T.none(q), near ? T.closest(near) : ""].filter(Boolean).join(" "),
      actions: closest.flatMap((c) => (c.kind === "task" ? [{ label: truncate(c.task.title, 32), payload: { type: "open_task" as const, taskId: c.task.id } }] : [])),
      intent: "find_items",
    };
  }
  // Loaded here, not at the top: routines.ts → runtime → registry → find.ts would be a load-order cycle.
  const { scheduleLabel } = await import("./routines.js");
  const tasks = items.filter((i): i is Extract<Found, { kind: "task" }> => i.kind === "task");
  focusOn(turn, ...tasks.slice(0, 3).map((t) => t.task.id).reverse());
  turn.state.listed = tasks.map((t) => t.task.id);
  const line = (i: Found) => {
    const where = `${T.matchedIn}: ${i.matchedIn.map((f) => FIELD_LABEL[f][lang]).join(" / ")}`;
    return i.kind === "task"
      ? `• ${i.task.title} (${i.task.dueAt ? dueLabel(i.task, turn) : T.noDue}) · ${where}`
      : `• ${i.routine.title} (${T.routine}, ${scheduleLabel(i.routine)}) · ${where}`;
  };
  const content = [T.found(items.length, q), ...items.slice(0, FIND_LIMIT).map(line)].join("\n");
  if (isWhatsapp(turn.channel)) return { content, intent: "find_items" };
  const cards: Card[] = [
    ...(tasks.length ? [{ type: "task_list" as const, title: `Matching "${q}"`, tasks: tasks.map((t) => serializeTask(t.task, turn.now)) }] : []),
    ...items.filter((i): i is Extract<Found, { kind: "routine" }> => i.kind === "routine").map((r) => ({ type: "routine" as const, routine: r.routine as unknown as Record<string, unknown> })),
  ];
  return { content, cards, intent: "find_items" };
}

export const findItemsCommand: Command = {
  name: "find_items",
  category: "tasks",
  summary: "Find tasks and routines about something (a name, place, course, word in the notes)",
  examples: ["Is there any task related to KFC?", "Anything with Kalma Chowk?", "KFC wala kaam"], // English + Roman Urdu
  schema: findFilterSchema as unknown as Command["schema"],
  undoable: false,
  parse(text, ctx): CommandArgs | null {
    return parseFindQuery(text, ctx);
  },
  async execute(turn, args) {
    return findReply(turn, findFilterSchema.parse(args));
  },
};
