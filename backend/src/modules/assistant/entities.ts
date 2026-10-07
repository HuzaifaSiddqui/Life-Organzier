import { Priority, RoutineFrequency, RoutinePriority, TaskType } from "@prisma/client";
import {
  addDaysYmd,
  diffDaysYmd,
  fmtYmd,
  formatClock,
  localParts,
  localYmd,
  parseClock,
  splitYmd,
  weekdayOfYmd,
} from "../../lib/time.js";

/**
 * Deterministic entity extraction. Dates, times, durations and recurrence are resolved here
 * against the user's own calendar (timezone-aware); the LLM is never trusted with date math.
 */

export type DateEntity = { ymd: string; text: string; fuzzy: boolean; past: boolean };
export type Entities = {
  date: DateEntity | null;
  time: string | null;
  timeExplicit: boolean;
  durationMinutes: number | null;
  priority: Priority | null;
  routinePriority: RoutinePriority | null;
  category: string | null;
  frequency: RoutineFrequency | null;
  daysOfWeek: number[] | null;
  dayOfMonth: number | null;
  progress: number | null;
  difficulty: number | null;
  tags: string[];
  context: string | null;
  flexibleTime: boolean;
  residual: string;
};

export type ExtractOptions = {
  now: Date;
  tz: string;
  contexts?: string[];
  customCategories?: string[];
};

const WEEKDAY_NAMES: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};
const WEEKDAY_RE = "(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty-five": 45, sixty: 60, ninety: 90, half: 0.5, couple: 2, few: 3,
};

export const CATEGORY_KEYWORDS: Array<{ category: string; re: RegExp }> = [
  { category: "Academic", re: /\b(assignment|homework|quiz|exam|midterm|final|lecture|class|course|study|studying|revise|revision|thesis|fyp|project report|lab|university|semester|chapter|syllabus|research paper|presentation slides)\b/i },
  { category: "Work", re: /\b(meeting|client|office|boss|standup|stand-up|deploy|deadline for work|report|email|proposal|interview|manager|colleague|sprint|presentation|invoice|work)\b/i },
  { category: "Health", re: /\b(gym|workout|exercise|run|jog|walk|yoga|meditat\w*|doctor|dentist|medicine|medication|pills?|sleep|diet|water|therapy|checkup|check-up|hospital|physio|stretch\w*)\b/i },
  { category: "Finance", re: /\b(bill|bills|payment|pay|bank|budget|rent|tax|taxes|salary|loan|invest\w*|expense|insurance|fee|fees)\b/i },
  { category: "Personal", re: /\b(family|mom|mother|dad|father|friend|birthday|shopping|groceries|grocery|clean|laundry|cook|call|haircut|car|bike|home|house|prayer|pray|namaz)\b/i },
];

const TAG_SUGGESTIONS: Array<{ re: RegExp; tags: string[] }> = [
  { re: /\bassignment|homework\b/i, tags: ["homework", "deadline"] },
  { re: /\bexam|quiz|midterm|final\b/i, tags: ["exam", "study"] },
  { re: /\bstudy|revise|revision|chapter\b/i, tags: ["study"] },
  { re: /\bmeeting|standup|call with\b/i, tags: ["meeting"] },
  { re: /\breview|proofread\b/i, tags: ["review"] },
  { re: /\bbill|payment|pay|rent|fee\b/i, tags: ["payment"] },
  { re: /\bdoctor|dentist|medicine|medication|checkup\b/i, tags: ["health"] },
  { re: /\bbuy|groceries|shopping\b/i, tags: ["errand"] },
];

export function suggestTags(text: string): string[] {
  const out = new Set<string>();
  for (const s of TAG_SUGGESTIONS) if (s.re.test(text)) s.tags.forEach((t) => out.add(t));
  return [...out].slice(0, 4);
}

export function suggestCategory(text: string, custom: string[] = []): string | null {
  for (const name of custom) {
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) return name;
  }
  for (const { category, re } of CATEGORY_KEYWORDS) if (re.test(text)) return category;
  return null;
}

class Cursor {
  constructor(public text: string) {}
  take(re: RegExp): RegExpMatchArray | null {
    const m = this.text.match(re);
    if (m && m.index !== undefined) {
      this.text = `${this.text.slice(0, m.index)} ${this.text.slice(m.index + m[0].length)}`.replace(/\s+/g, " ").trim();
    }
    return m;
  }
}

function num(word: string): number {
  const n = Number(word);
  return Number.isFinite(n) ? n : (NUMBER_WORDS[word.toLowerCase()] ?? NaN);
}

function nextWeekday(todayYmd: string, target: number, allowToday: boolean): string {
  const cur = weekdayOfYmd(todayYmd);
  let delta = (target - cur + 7) % 7;
  if (delta === 0 && !allowToday) delta = 7;
  return addDaysYmd(todayYmd, delta);
}

function lastDayOfMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function monthIndex(word: string): number {
  return MONTHS.indexOf(word.slice(0, 3).toLowerCase());
}

function resolveYear(todayYmd: string, mo: number, da: number, explicitYear?: number): string | null {
  const today = splitYmd(todayYmd);
  if (!today) return null;
  if (explicitYear) {
    const y = explicitYear < 100 ? 2000 + explicitYear : explicitYear;
    const c = fmtYmd(y, mo, da);
    return splitYmd(c) ? c : null;
  }
  const c = fmtYmd(today.y, mo, da);
  if (!splitYmd(c)) return null;
  // A month/day earlier than today without a year means next year, unless it was within the last week.
  if (c < todayYmd && diffDaysYmd(c, todayYmd) > 7) return splitYmd(fmtYmd(today.y + 1, mo, da)) ? fmtYmd(today.y + 1, mo, da) : null;
  return c;
}

function extractDate(cur: Cursor, todayYmd: string, now: Date, tz: string): { date: DateEntity | null; time: string | null } {
  const mk = (ymd: string, text: string, fuzzy = false): DateEntity => ({ ymd, text, fuzzy, past: ymd < todayYmd });

  // Relative instants: "in 2 hours", "after 30 minutes"
  const rel = cur.take(/\b(?:in|after|within)\s+(\d{1,3}|an?|one|two|three|four|five|ten|fifteen|twenty|thirty|half an?)\s*(hours?|hrs?|minutes?|mins?)\b/i);
  if (rel) {
    const amount = rel[1].toLowerCase().startsWith("half") ? 0.5 : num(rel[1].toLowerCase());
    const minutes = /^h/i.test(rel[2]) ? amount * 60 : amount;
    const at = new Date(now.getTime() + minutes * 60000);
    const p = localParts(at, tz);
    return { date: mk(fmtYmd(p.y, p.mo, p.da), rel[0]), time: formatClock(p.h, p.mi) };
  }
  const relDays = cur.take(/\b(?:in|after)\s+(\d{1,2}|an?|one|two|three|four|five|six|seven|ten|couple of|few)\s*(days?|weeks?)\b/i);
  if (relDays) {
    const n = num(relDays[1].replace(/\s+of$/, "").toLowerCase());
    const days = /^w/i.test(relDays[2]) ? n * 7 : n;
    return { date: mk(addDaysYmd(todayYmd, Math.round(days)), relDays[0]), time: null };
  }

  let m = cur.take(/\b(?:the\s+)?day\s+after\s+tomorrow\b/i);
  if (m) return { date: mk(addDaysYmd(todayYmd, 2), m[0]), time: null };
  m = cur.take(/\b(today|tonight|this evening|this morning|this afternoon)\b/i);
  if (m) {
    const word = m[1].toLowerCase();
    const time = word === "tonight" ? "9 PM" : word === "this evening" ? "6 PM" : word === "this morning" ? "9 AM" : word === "this afternoon" ? "3 PM" : null;
    return { date: mk(todayYmd, m[0]), time };
  }
  m = cur.take(/\b(tomorrow|tmrw|tmr)(?:\s+(morning|afternoon|evening|night))?\b/i);
  if (m) {
    const part = m[2]?.toLowerCase();
    return { date: mk(addDaysYmd(todayYmd, 1), m[0]), time: part ? (formatFromWord(part) ?? null) : null };
  }
  m = cur.take(/\byesterday\b/i);
  if (m) return { date: mk(addDaysYmd(todayYmd, -1), m[0]), time: null };

  const weekday = weekdayOfYmd(todayYmd);
  m = cur.take(/\b(this|next)\s+weekend\b/i);
  if (m) {
    const sat = weekday === 6 || weekday === 0 ? (weekday === 6 ? todayYmd : addDaysYmd(todayYmd, -1)) : nextWeekday(todayYmd, 6, false);
    const ymd = m[1].toLowerCase() === "next" ? addDaysYmd(sat, 7) : sat < todayYmd ? todayYmd : sat;
    return { date: mk(ymd, m[0], true), time: null };
  }
  m = cur.take(/\b(?:by\s+)?(?:the\s+)?end\s+of\s+(?:the\s+|this\s+)?(week|month)\b/i);
  if (m) {
    if (m[1].toLowerCase() === "week") return { date: mk(nextWeekday(todayYmd, 5, true), m[0]), time: null };
    const t = splitYmd(todayYmd)!;
    return { date: mk(fmtYmd(t.y, t.mo, lastDayOfMonth(t.y, t.mo)), m[0]), time: null };
  }
  m = cur.take(/\b(this|next)\s+(week|month)\b/i);
  if (m) {
    const which = m[1].toLowerCase();
    if (m[2].toLowerCase() === "week") {
      const ymd = which === "this" ? nextWeekday(todayYmd, 5, true) : nextWeekday(todayYmd, 1, false);
      return { date: mk(ymd, m[0], true), time: null };
    }
    const t = splitYmd(todayYmd)!;
    const ymd = which === "this" ? fmtYmd(t.y, t.mo, lastDayOfMonth(t.y, t.mo)) : t.mo === 12 ? fmtYmd(t.y + 1, 1, 1) : fmtYmd(t.y, t.mo + 1, 1);
    return { date: mk(ymd, m[0], true), time: null };
  }

  // ISO / numeric dates
  m = cur.take(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) {
    const ymd = fmtYmd(Number(m[1]), Number(m[2]), Number(m[3]));
    if (splitYmd(ymd)) return { date: mk(ymd, m[0]), time: null };
  }
  m = cur.take(/(?<![:\d])\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b(?![:\d]|\s*(?:am|pm|a\.m|p\.m|%|hours?|hrs?|min))/i);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    // M/D when the second part can't be a month; otherwise D/M (Pakistan/UK convention).
    const [mo, da] = b > 12 && a <= 12 ? [a, b] : [b, a];
    const ymd = resolveYear(todayYmd, mo, da, m[3] ? Number(m[3]) : undefined);
    if (ymd) return { date: mk(ymd, m[0]), time: null };
  }
  m = cur.take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s+(\\d{4}))?\\b`, "i"));
  if (m) {
    const ymd = resolveYear(todayYmd, monthIndex(m[2]) + 1, Number(m[1]), m[3] ? Number(m[3]) : undefined);
    if (ymd) return { date: mk(ymd, m[0]), time: null };
  }
  m = cur.take(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "i"));
  if (m) {
    const ymd = resolveYear(todayYmd, monthIndex(m[1]) + 1, Number(m[2]), m[3] ? Number(m[3]) : undefined);
    if (ymd) return { date: mk(ymd, m[0]), time: null };
  }

  // Weekdays: "next Friday", "on Monday", "by Fri", "this Thursday"
  m = cur.take(new RegExp(`\\b(next|this|coming|on|by|before|until|till)?\\s*${WEEKDAY_RE}\\b(?!\\s*(?:and|&|,|\\/)\\s*${WEEKDAY_RE})`, "i"));
  if (m) {
    const target = WEEKDAY_NAMES[m[2].toLowerCase()];
    if (target !== undefined) {
      const prefix = (m[1] ?? "").toLowerCase();
      const ymd = prefix === "next" ? nextWeekday(todayYmd, target, false) : nextWeekday(todayYmd, target, true);
      return { date: mk(ymd, m[0].trim()), time: null };
    }
  }
  return { date: null, time: null };
}

function formatFromWord(word: string): string | null {
  const c = parseClock(word);
  return c ? formatClock(c.h, c.m) : null;
}

function extractTime(cur: Cursor): { time: string | null; explicit: boolean; rangeMinutes: number | null } {
  // Ranges: "10-11:30 AM", "2:30 - 4:00 PM", "from 9 to 11 am"
  let m = cur.take(/\b(?:from\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to|till|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (m) {
    const endSuffix = m[6].toLowerCase();
    const startSuffix = (m[3] ?? (Number(m[1]) > Number(m[4]) && endSuffix === "pm" ? "am" : endSuffix)).toLowerCase();
    const s = parseClock(`${m[1]}:${m[2] ?? "00"} ${startSuffix}`);
    const e = parseClock(`${m[4]}:${m[5] ?? "00"} ${endSuffix}`);
    if (s && e) {
      const range = (e.h * 60 + e.m - (s.h * 60 + s.m) + 1440) % 1440;
      return { time: formatClock(s.h, s.m), explicit: true, rangeMinutes: range || null };
    }
  }
  m = cur.take(/\b(?:at|@|by|around|before)?\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?=\s|$|[,.!?])/i);
  if (m) {
    const c = parseClock(`${m[1]}:${m[2] ?? "00"} ${m[3].replace(/\./g, "")}`);
    if (c) return { time: formatClock(c.h, c.m), explicit: true, rangeMinutes: null };
  }
  m = cur.take(/\b(?:at|@|by|around)\s+(\d{1,2}):(\d{2})\b/i) ?? cur.take(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) {
    const c = parseClock(`${m[1]}:${m[2]}`);
    if (c) return { time: formatClock(c.h, c.m), explicit: true, rangeMinutes: null };
  }
  m = cur.take(/\b(?:at|@|by|around)\s+(\d{1,2})\b(?!\s*(?:hours?|hrs?|minutes?|mins?|%|days?|weeks?))/i);
  if (m) {
    const h = Number(m[1]);
    if (h >= 1 && h <= 12) {
      // Bare hours: 1–7 → PM, 8–11 → AM, 12 → noon.
      const c = parseClock(`${h} ${h >= 8 && h <= 11 ? "am" : "pm"}`);
      if (c) return { time: formatClock(c.h, c.m), explicit: true, rangeMinutes: null };
    }
    if (h >= 13 && h <= 23) return { time: formatClock(h, 0), explicit: true, rangeMinutes: null };
  }
  m = cur.take(/\b(noon|midday|midnight|eod|end of (?:the )?day)\b/i);
  if (m) {
    const w = m[1].toLowerCase().startsWith("end") ? "eod" : m[1].toLowerCase();
    return { time: formatFromWord(w), explicit: true, rangeMinutes: null };
  }
  m = cur.take(/\b(?:in the\s+)?(morning|afternoon|evening|night)\b/i);
  if (m) return { time: formatFromWord(m[1].toLowerCase()), explicit: false, rangeMinutes: null };
  return { time: null, explicit: false, rangeMinutes: null };
}

function extractDuration(cur: Cursor): number | null {
  let m = cur.take(/\b(\d{1,2})\s*h(?:ours?|rs?)?\s*(?:and\s*)?(\d{1,2})\s*m(?:in(?:ute)?s?)?\b/i);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = cur.take(/\b(?:for\s+)?(?:about\s+|around\s+)?(half an hour|an hour and a half|an hour|a couple of hours|a few hours)\b/i);
  if (m) {
    const phrase = m[1].toLowerCase();
    return phrase === "half an hour" ? 30 : phrase === "an hour and a half" ? 90 : phrase === "an hour" ? 60 : phrase.includes("couple") ? 120 : 180;
  }
  m = cur.take(/\b(?:for\s+|takes?\s+|needs?\s+)?(?:about\s+|around\s+|roughly\s+)?(\d{1,3}(?:\.\d)?|one|two|three|four|five|six|ten|fifteen|twenty|thirty|forty-five|ninety)[\s-]*(hours?|hrs?|h|minutes?|mins?|m)\b(?!\s*(?:before|after|ago|later|left))/i);
  if (m) {
    const n = num(m[1].toLowerCase());
    if (!Number.isFinite(n)) return null;
    const minutes = /^h/i.test(m[2]) ? Math.round(n * 60) : Math.round(n);
    return minutes > 0 && minutes <= 16 * 60 ? minutes : null;
  }
  return null;
}

function extractFrequency(cur: Cursor, todayYmd: string): { frequency: RoutineFrequency | null; days: number[] | null; dayOfMonth: number | null } {
  let m = cur.take(/\b(?:every\s*day|everyday|daily|each day|every (?:morning|evening|night|afternoon)|each (?:morning|evening|night))\b/i);
  if (m) {
    const part = m[0].match(/morning|evening|night|afternoon/i);
    if (part) cur.text = `${cur.text} ${part[0]}`.trim();
    return { frequency: RoutineFrequency.DAILY, days: null, dayOfMonth: null };
  }
  m = cur.take(/\b(?:every\s+|on\s+)?weekdays\b/i);
  if (m) return { frequency: RoutineFrequency.CUSTOM, days: [1, 2, 3, 4, 5], dayOfMonth: null };
  m = cur.take(/\b(?:every|on)\s+weekends?\b|(?<!(?:this|next)\s)\bweekends\b/i);
  if (m) return { frequency: RoutineFrequency.CUSTOM, days: [0, 6], dayOfMonth: null };
  m = cur.take(/\b(?:MWF|M\/W\/F)\b/);
  if (m) return { frequency: RoutineFrequency.WEEKLY, days: [1, 3, 5], dayOfMonth: null };
  m = cur.take(/\b(?:TTh|TR|T\/Th)\b/);
  if (m) return { frequency: RoutineFrequency.WEEKLY, days: [2, 4], dayOfMonth: null };
  // "every Monday and Wednesday", "Mondays & Fridays", "Tue/Thu", "on mon, wed, fri"
  const list = new RegExp(`\\b(?:every\\s+|on\\s+)?(${WEEKDAY_RE}s?(?:\\s*(?:,|&|and|\\/)\\s*${WEEKDAY_RE}s?)+)\\b`, "i");
  m = cur.take(list);
  if (m) {
    const days = [...new Set((m[1].toLowerCase().match(/[a-z]+/g) ?? []).map((w) => WEEKDAY_NAMES[w.replace(/s$/, "")]).filter((d) => d !== undefined))];
    if (days.length) return { frequency: RoutineFrequency.WEEKLY, days: days.sort(), dayOfMonth: null };
  }
  m = cur.take(new RegExp(`\\b(?:every|each)\\s+${WEEKDAY_RE}\\b|\\b${WEEKDAY_RE}s\\b`, "i"));
  if (m) {
    const word = (m[1] ?? m[2]).toLowerCase();
    const d = WEEKDAY_NAMES[word];
    if (d !== undefined) return { frequency: RoutineFrequency.WEEKLY, days: [d], dayOfMonth: null };
  }
  m = cur.take(/\b(?:weekly|every week|once a week)\b/i);
  if (m) return { frequency: RoutineFrequency.WEEKLY, days: [weekdayOfYmd(todayYmd)], dayOfMonth: null };
  m = cur.take(/\b(?:monthly|every month|once a month)(?:\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?)?\b/i);
  if (m) return { frequency: RoutineFrequency.MONTHLY, days: null, dayOfMonth: m[1] ? Number(m[1]) : Number(todayYmd.slice(8, 10)) };
  m = cur.take(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\s+of\s+every\s+month\b/i);
  if (m) return { frequency: RoutineFrequency.MONTHLY, days: null, dayOfMonth: Number(m[1]) };
  return { frequency: null, days: null, dayOfMonth: null };
}

export function extractEntities(text: string, opts: ExtractOptions): Entities {
  const todayYmd = localYmd(opts.now, opts.tz);
  const cur = new Cursor(text.replace(/\s+/g, " ").trim());

  const tags: string[] = [];
  let tagMatch: RegExpMatchArray | null;
  while ((tagMatch = cur.take(/#([a-z0-9][\w-]{0,30})/i))) tags.push(tagMatch[1].toLowerCase());

  let progress: number | null = null;
  const pm = cur.take(/\b(\d{1,3})\s*(?:%|percent)\s*(?:done|complete|completed|finished|through)?\b/i);
  if (pm) progress = Math.min(100, Number(pm[1]));
  else if (cur.take(/\b(?:half\s*(?:way\s+)?(?:done|through|finished)|halfway)\b/i)) progress = 50;
  else if (cur.take(/\b(?:almost|nearly)\s+(?:done|finished|complete)\b/i)) progress = 90;
  else if (cur.take(/\b(?:just\s+)?started\b/i)) progress = 10;

  const frequency = extractFrequency(cur, todayYmd);
  const dateResult = extractDate(cur, todayYmd, opts.now, opts.tz);
  const timeResult = extractTime(cur);
  let duration = extractDuration(cur);
  if (!duration && timeResult.rangeMinutes) duration = timeResult.rangeMinutes;
  const time = timeResult.time ?? dateResult.time;
  const flexibleTime = /\b(flexible|any ?time|whenever|no fixed time)\b/i.test(text);

  let priority: Priority | null = null;
  let routinePriority: RoutinePriority | null = null;
  if (cur.take(/\b(?:mandatory|must[- ]do|non[- ]negotiable|compulsory)\b/i)) routinePriority = RoutinePriority.MANDATORY;
  else if (cur.take(/\boptional\b/i)) routinePriority = RoutinePriority.NORMAL;
  if (cur.take(/\b(?:urgent(?:ly)?|asap|critical|very important|top priority|immediately)\b/i)) priority = Priority.URGENT;
  else if (cur.take(/\b(?:high[- ]priority|high|important)\b/i)) priority = Priority.HIGH;
  else if (cur.take(/\b(?:low[- ]priority|low|whenever|someday|not urgent)\b/i)) priority = Priority.LOW;
  else if (cur.take(/\b(?:medium|normal)(?:[- ]priority)?\b/i)) priority = Priority.MEDIUM;
  if (!routinePriority && priority === Priority.HIGH) routinePriority = RoutinePriority.IMPORTANT;

  let difficulty: number | null = null;
  if (/\bvery (?:hard|difficult)\b/i.test(text)) difficulty = 5;
  else if (/\b(hard|difficult|tough|challenging|complex)\b/i.test(text)) difficulty = 4;
  else if (/\b(easy|quick|simple|small|light)\b/i.test(text)) difficulty = 2;

  let context: string | null = null;
  for (const c of opts.contexts ?? []) {
    const bare = c.replace(/^(at|in)\s+/i, "");
    const re = new RegExp(`\\b(?:at|in|when at|when in)\\s+(?:the\\s+)?${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (cur.take(re)) {
      context = c;
      break;
    }
  }

  const category = suggestCategory(text, opts.customCategories);
  return {
    date: dateResult.date,
    time,
    timeExplicit: timeResult.explicit || Boolean(dateResult.time && /tonight|this (morning|evening|afternoon)|in \d/i.test(dateResult.date?.text ?? "")),
    durationMinutes: duration,
    priority,
    routinePriority,
    category,
    frequency: frequency.frequency,
    daysOfWeek: frequency.days,
    dayOfMonth: frequency.dayOfMonth,
    progress,
    difficulty,
    tags,
    context,
    flexibleTime,
    residual: cur.text,
  };
}

const FILLER_PREFIX =
  /^(?:(?:hey|hi|ok|okay|so|um|uh|well|please|pls|plz)[,!\s]+)*(?:(?:can|could|would|will) you\s+|i\s+(?:need|have|want|got|must|should|gotta|wanna)\s+(?:to\s+)?|i'?ll\s+|i'?m\s+going\s+to\s+|i\s+am\s+going\s+to\s+|remind\s+me\s+(?:to\s+|about\s+)?|don'?t\s+(?:let\s+me\s+)?forget\s+(?:to\s+|about\s+)?|remember\s+to\s+|add\s+(?:a\s+)?(?:new\s+)?(?:task|todo|to-do|reminder)\s*(?:to|for|about|:)?\s*|create\s+(?:a\s+)?(?:new\s+)?(?:task|todo|reminder)\s*(?:to|for|about|:)?\s*|set\s+(?:a\s+)?reminder\s*(?:to|for|about)?\s*|make\s+(?:a\s+)?(?:task|note)\s*(?:to|for|about)?\s*|schedule\s+|plan\s+(?:to\s+)?|task\s*:\s*|todo\s*:\s*)+/i;

/** Turns the residual text into a short actionable title. */
export function cleanTitle(residual: string): string {
  let t = residual.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i += 1) t = t.replace(FILLER_PREFIX, "").replace(/^i\s+(?:to\s+)?/i, "").trim();
  t = t
    .replace(/\b(?:(?:and|which|that)\s+)?(?:is\s+|it'?s\s+)?(?:due|deadline)\b\s*$/i, "")
    .replace(/\s+(?:by|on|at|for|due|before|until|till|in|from|to|the|this|next|and|of|with|around|it'?s|is)\s*$/i, "")
    .replace(/\s+(?:by|on|at|for|due|before|until|till|in|from|to|the|this|next|and|of|with|around|it'?s|is)\s*$/i, "")
    .replace(/^(?:to|for|about|that|the task of|a task to)\s+/i, "")
    .replace(/[\s,.;:!?-]+$/g, "")
    .replace(/^[\s,.;:!?-]+/g, "")
    .trim();
  if (t.length > 120) t = `${t.slice(0, 117).replace(/\s+\S*$/, "")}…`;
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

const HABIT_RE =
  /\b(meditat\w*|workout|work out|exercise|gym|jog\w*|run(?:ning)?|walk(?:ing)?|yoga|pray\w*|prayer|namaz|medication|medicine|pills?|vitamins?|breakfast|lunch|dinner|read(?:ing)?|journal\w*|stretch\w*|sleep|wake up|water|skincare|study time)\b/i;
const FIXED_RE = /\b(class|lecture|meeting|appointment|interview|seminar|lab session|tutorial|call with|flight|train|bus|exam|quiz|standup|stand-up|doctor|dentist)\b/i;
const DEADLINE_RE = /\b(by|due|deadline|submit|submission|assignment|hand in|turn in|before|until|no later than)\b/i;
const DURATION_ACTIVITY_RE = /\b(study|studying|revise|revision|practice|read|write|writing|work on|research|prepare|prep|code|coding|learn|review)\b/i;

export function isHabitLike(text: string): boolean {
  return HABIT_RE.test(text);
}

/** Task type classification (FR-TM-001 §4). */
export function classifyTaskType(text: string, e: Pick<Entities, "durationMinutes" | "time" | "frequency">): TaskType {
  if (e.frequency) return TaskType.ROUTINE;
  if (FIXED_RE.test(text) && e.time) return TaskType.FIXED;
  if (DEADLINE_RE.test(text)) return TaskType.DEADLINE;
  if (e.durationMinutes || DURATION_ACTIVITY_RE.test(text)) return TaskType.DURATION;
  return e.time ? TaskType.DEADLINE : TaskType.FLEXIBLE;
}

export function needsDurationByNature(text: string, type: TaskType): boolean {
  return type === TaskType.DURATION || (type === TaskType.FLEXIBLE && DURATION_ACTIVITY_RE.test(text));
}

/** Generic one-word titles ("study physics" is fine, "study" alone is not). */
export function isVagueTitle(title: string | null): boolean {
  if (!title) return true;
  const words = title.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const vague = new Set([
    "study", "work", "stuff", "things", "thing", "something", "some", "task", "tasks", "it", "this", "that", "do", "doing",
    "homework", "chores", "reminder", "todo", "learn", "read", "practice", "a", "an", "the", "my", "on", "for", "to",
    "get", "make", "go", "finish", "complete", "start", "need", "have", "everything", "anything", "lots", "of", "studying",
  ]);
  return words.every((w) => vague.has(w));
}
