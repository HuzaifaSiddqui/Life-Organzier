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
  /** FR-LB-001 place named in the message ("from Ali Medical Store", "ghar ja ke"); not removed from the title. */
  location: string | null;
  flexibleTime: boolean;
  residual: string;
};

export type ExtractOptions = {
  now: Date;
  tz: string;
  contexts?: string[];
  customCategories?: string[];
  /** The user's saved place names: weak markers (at/in/from/se/par/pe) also accept these. */
  places?: string[];
};

const WEEKDAY_NAMES: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};
const WEEKDAY_RE = "(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)";
/* ---- Roman Urdu (Urdu typed in Latin script): days, parts of the day and clock times -------------- */

/** Weekday words; Saturday is "hafta" (guarded below, since "hafta/hafte" also means "week"). */
const UR_WEEKDAYS: Array<{ re: string; day: number }> = [
  { re: "(?:a?i|e)tt?waa?r", day: 0 },
  { re: "peer(?!\\s+(?:review|pressure|group|feedback|mentor\\w*|tutor\\w*|learning))|pir|somwaa?r|somvaa?r|sombar", day: 1 },
  { re: "mangal(?:waa?r|vaa?r)?", day: 2 },
  { re: "budh(?:waa?r|vaa?r)?", day: 3 },
  { re: "jum[ea]ra{1,2}t", day: 4 },
  { re: "jumm?(?:a|e|ey)h?", day: 5 },
  { re: "haftah?|hafte|haftay", day: 6 },
];
const UR_WEEKDAY_RE = `(${UR_WEEKDAYS.map((w) => w.re).join("|")})`;
const UR_WEEKDAY_TESTS = UR_WEEKDAYS.map((w) => ({ re: new RegExp(`^(?:${w.re})$`, "i"), day: w.day }));
const UR_PART_RE = "subah|sawere|dopahar|dupahar|shaam|raat";
/** Trailing particle that belongs to a date: "kal ko", "Friday tak", "kal pe", "jumme se pehle". */
const UR_FOLLOW = "(?:\\s+(?:ko|tak|pe|par|se\\s+pehle|se\\s+pahle))?";
const UR_HOUR_WORDS: Record<string, number> = {
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, che: 6, chhay: 6, chay: 6,
  saat: 7, aath: 8, ath: 8, nau: 9, das: 10, gyarah: 11, gyara: 11, giyarah: 11, barah: 12, baarah: 12, bara: 12,
};
const UR_HOUR_RE = `\\d{1,2}|${Object.keys(UR_HOUR_WORDS).join("|")}`;

function urduPart(word: string | undefined): "subah" | "dopahar" | "shaam" | "raat" | null {
  const w = word?.toLowerCase();
  if (!w) return null;
  return w === "sawere" ? "subah" : w === "dupahar" ? "dopahar" : (w as "subah" | "dopahar" | "shaam" | "raat");
}

/**
 * Hour (0–23) for a Roman Urdu clock reading. "subah/shaam/raat" decide AM/PM; without one the
 * existing default applies (1–7 → PM, 8–11 → AM, 12 → noon). "raat" is PM from 6, midnight at 12, AM after.
 */
function urduHour(h: number, part: ReturnType<typeof urduPart>): number | null {
  if (h >= 13 && h <= 23) return h;
  if (h < 1 || h > 12) return null;
  switch (part) {
    case "subah":
      return h;
    case "shaam":
      return h === 12 ? 12 : h + 12;
    case "raat":
      return h === 12 ? 0 : h >= 6 ? h + 12 : h;
    default: // dopahar and no part of day: 12 noon, 1–7 PM, 8–11 AM
      return h === 12 ? 12 : h >= 8 ? h : h + 12;
  }
}

/** "9 baje", "subah 9 baje", "shaam 5:30 baje", "saarhe teen baje", "sawa do baje", "pone char baje", "dhai baje". */
function extractUrduClock(cur: Cursor): string | null {
  const before = `(?:(${UR_PART_RE})\\s+(?:(?:ke|ko|mein|me)\\s+)?)?`;
  const after = `(?:\\s+(${UR_PART_RE})\\b)?`;
  const hour = `(${UR_HOUR_RE})`;
  const num = (w: string) => UR_HOUR_WORDS[w.toLowerCase()] ?? Number(w);

  // saarhe/sawa/pone X: X:30, X:15, (X-1):45
  let m = cur.take(new RegExp(`\\b${before}(saa?rhe|saa?de|sadhe|sawa|sava|pone|paune)\\s+${hour}\\s*(?:baje|bje|tak|pe|par)\\b${after}`, "i"));
  if (m) {
    const base = urduHour(num(m[3]), urduPart(m[1] ?? m[4]));
    if (base !== null) {
      const kind = m[2].toLowerCase();
      const total = base * 60 + (/^sa(?:a?rhe|a?de|dhe)$/.test(kind) ? 30 : /^sa(?:wa|va)$/.test(kind) ? 15 : -15);
      const t = (total + 1440) % 1440;
      return formatClock(Math.floor(t / 60), t % 60);
    }
  }
  // dhai baje (2:30), dedh/derh baje (1:30)
  m = cur.take(new RegExp(`\\b${before}(dhai|dhaai|dedh|derh)\\s+(?:baje|bje)\\b${after}`, "i"));
  if (m) {
    const h = urduHour(/^dha/i.test(m[2]) ? 2 : 1, urduPart(m[1] ?? m[3]));
    if (h !== null) return formatClock(h, 30);
  }
  // X baje, X:MM baje
  m = cur.take(new RegExp(`\\b${before}${hour}(?::(\\d{2}))?\\s*(?:baje|bje)\\b${after}`, "i"));
  if (m) {
    const h = urduHour(num(m[2]), urduPart(m[1] ?? m[4]));
    const min = m[3] ? Number(m[3]) : 0;
    if (h !== null && min < 60) return formatClock(h, min);
  }
  return null;
}

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

  // Roman Urdu: "aaj", "kal" (tomorrow), "parson" (day after tomorrow), "agle hafte" (next week), "is hafte"
  m = cur.take(new RegExp(`\\bparson${UR_FOLLOW}\\b`, "i"));
  if (m) return { date: mk(addDaysYmd(todayYmd, 2), m[0]), time: null };
  m = cur.take(new RegExp(`\\baaj${UR_FOLLOW}\\b`, "i"));
  if (m) return { date: mk(todayYmd, m[0]), time: null };
  m = cur.take(new RegExp(`\\bkal${UR_FOLLOW}\\b`, "i")); // "kal" can mean yesterday too; tomorrow is the default
  if (m) return { date: mk(addDaysYmd(todayYmd, 1), m[0]), time: null };
  m = cur.take(new RegExp(`\\b(?:(agla|agle|agli)\\s+(?:hafta|hafte|haftay|week)|(is)\\s+(?:hafta|hafte|haftay))${UR_FOLLOW}\\b`, "i"));
  if (m) {
    const ymd = m[1] ? nextWeekday(todayYmd, 1, false) : nextWeekday(todayYmd, 5, true);
    return { date: mk(ymd, m[0].trim(), true), time: null };
  }
  // Roman Urdu weekdays: "peer", "agle jumme ko", "is itwar", "mangal tak". "hafta/hafte" is Saturday unless
  // it is part of "har hafte" (every week), "ek hafte" (one week)…
  m = cur.take(
    new RegExp(
      `\\b(?:(agla|agle|agli|is|aane\\s+wala|aane\\s+wale|aane\\s+wali)\\s+)?(?<!\\b(?:a|my|the|your|his|her|our|their|har|pichla|pichle|poore|puray|ek|do|teen|char|chaar)\\s)${UR_WEEKDAY_RE}${UR_FOLLOW}\\b`,
      "i",
    ),
  );
  if (m) {
    const target = UR_WEEKDAY_TESTS.find((w) => w.re.test(m![2]))?.day;
    if (target !== undefined) {
      const next = /^(agla|agle|agli|aane)/i.test(m[1] ?? "");
      return { date: mk(next ? nextWeekday(todayYmd, target, false) : nextWeekday(todayYmd, target, true), m[0].trim()), time: null };
    }
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
  const urdu = extractUrduClock(cur);
  if (urdu) return { time: urdu, explicit: true, rangeMinutes: null };
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
  // Roman Urdu parts of the day without a clock time: subah 9 AM · dopahar 3 PM · shaam 6 PM · raat 9 PM
  m = cur.take(new RegExp(`\\b(${UR_PART_RE})\\b`, "i"));
  if (m) {
    const part = urduPart(m[1]);
    return { time: formatFromWord(part === "subah" ? "morning" : part === "dopahar" ? "afternoon" : part === "shaam" ? "evening" : "night"), explicit: false, rangeMinutes: null };
  }
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
  // Roman Urdu: "3 ghantay lagenge", "aadha ghanta lagega", "dedh ghanta", "45 minute lagein ge".
  m = cur.take(
    /\b(?:taqreeban\s+|lagbhag\s+)?(\d{1,2}(?:\.\d)?|aadha|adha|dedh|derh|ek|do|teen|char|chaar|paanch|panch)\s*(ghant(?:a|ay|ey|e|on)|minat|mint|minute?s?)\b(?:\s*(?:tak|ka kaam))?(?:\s+(?:lag(?:e(?:n|in)?\s*ge|enge|ega|egi|ay?\s*ga|ain\s*ge|\s+jaye?n?\s*ge?)))?/i,
  );
  if (m) {
    const words: Record<string, number> = { aadha: 0.5, adha: 0.5, dedh: 1.5, derh: 1.5, ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5 };
    const raw = m[1].toLowerCase();
    const n = words[raw] ?? Number(raw); // "aadha ghanta" = 30 min, "dedh ghanta" = 90 min
    if (!Number.isFinite(n)) return null;
    const minutes = /^ghant/i.test(m[2]) ? Math.round(n * 60) : Math.round(n);
    if (minutes > 0 && minutes <= 16 * 60) return minutes;
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

  const location = extractLocation(cur.text, opts.places ?? []);

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
    location,
    flexibleTime,
    residual: cur.text,
  };
}

/* ------------------------------------------------------------------ places (FR-LB-001) */

/** Words that make a phrase a place ("Ali Medical Store", "Model Town", "university"). */
const PLACE_WORDS =
  /\b(?:store|shop|market|bazaa?r|mall|plaza|university|uni|campus|college|school|office|daftar|ghar|home|hostel|hospital|clinic|pharmacy|medical|bank|atm|masjid|mosque|park|chowk|road|town|colony|block|phase|station|stop|gym|hotel|restaurant|cafe|library|mandi|cent(?:er|re)|airport|salon|bakery|stadium|dhaba)\b/i;
/** Where a place name ends. */
const PLACE_END = String.raw`(?=\s*(?:[,.;!?]|$|\b(?:and|aur|to|toh|by|before|after|on|for|tomorrow|today|tonight|kal|aaj|when|then|phir|at\s+\d|ko|ke|ka|ki|hai|hain|karna|karni|lena|leni|dena|deni)\b))`;
const EN_STRONG = new RegExp(String.raw`\b(?:when\s+i(?:'m|\s+am)\s+(?:at|in|near)|when\s+i\s+(?:reach|get\s+to|pass|arrive\s+at|go\s+to)|while\s+(?:at|in)|near)\s+(?:the\s+)?([a-z][\w'&.-]*(?:\s+[a-z0-9][\w'&.-]*){0,4}?)${PLACE_END}`, "i");
const EN_WEAK = new RegExp(String.raw`\b(?:at|from|in)\s+(?:the\s+)?([a-z][\w'&.-]*(?:\s+[a-z0-9][\w'&.-]*){0,4}?)${PLACE_END}`, "gi");
/** Roman Urdu markers come after the place: "ghar ja ke", "Ali medical store se". */
const UR_STRONG = /((?:[a-z][\w'&.-]*\s+){0,2}[a-z][\w'&.-]*)\s+(?:ja\s*ke|jaa\s*ke|ja\s*kar|pohu?n?ch\s*ke|pahunch\s*ke|jaa?un|jaa?o)\b/i;
const UR_WEAK = /((?:[a-z][\w'&.-]*\s+){0,2}[a-z][\w'&.-]*)\s+(?:se|par|pe)\b/gi;
const NOT_PLACE_START = /^(?:mujhe|main|mein|mai|ne|ko|phir|pehle|bhi|aur|i|me|my|a|an|the|to|go|buy|get|pick|drop|submit)$/i;

function knownPlace(candidate: string, places: string[]): boolean {
  const c = candidate.toLowerCase();
  return places.some((p) => p.toLowerCase() === c);
}

/** Keeps the place part of a Roman Urdu phrase: from a leading proper name or the first place word. */
function trimUrduCandidate(raw: string): string {
  const words = raw.trim().split(/\s+/);
  while (words.length > 1 && NOT_PLACE_START.test(words[0])) words.shift();
  const firstPlace = words.findIndex((w) => PLACE_WORDS.test(w));
  if (firstPlace > 0) {
    const start = /^[A-Z]/.test(words[firstPlace - 1]) && !NOT_PLACE_START.test(words[firstPlace - 1]) ? firstPlace - 1 : firstPlace;
    return words.slice(start).join(" ");
  }
  return words.join(" ");
}

/**
 * The place a task should happen at, or null. Strong markers ("near", "when I reach", "ja ke") accept
 * any name; weak ones ("at", "from", "in", "se", "par", "pe") need a place word or a saved place name,
 * so "at 5", "in the morning", "Ali se baat" are not places.
 */
export function extractLocation(text: string, places: string[] = []): string | null {
  const clean = (p: string) => p.replace(/\s+/g, " ").replace(/[.,]+$/, "").trim();
  const strong = EN_STRONG.exec(text);
  if (strong) return clean(strong[1]);
  const urStrong = UR_STRONG.exec(text);
  if (urStrong) return clean(trimUrduCandidate(urStrong[1]));
  for (const m of text.matchAll(EN_WEAK)) {
    const p = clean(m[1]);
    if (PLACE_WORDS.test(p) || knownPlace(p, places)) return p;
  }
  for (const m of text.matchAll(UR_WEAK)) {
    const p = clean(trimUrduCandidate(m[1]));
    if (PLACE_WORDS.test(p) || knownPlace(p, places)) return p;
  }
  return null;
}

/**
 * The title without "from/at/in/near <place>" once that place is the task's location: "Eat burger from KFC
 * kalma chowk" → "Eat burger". Unchanged when the place isn't there or nothing would be left.
 */
export function titleWithoutPlace(title: string, place: string): string {
  const escaped = place.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const out = title.replace(new RegExp(`\\s+(?:at|from|in|near)\\s+(?:the\\s+)?${escaped}(?=\\s|$|[,.!?])`, "i"), "").trim();
  return out.length >= 2 ? out : title;
}

/* ---- chat command helpers: time ranges and weekday lists ------------------------------------------ */

const UR_SCRIPT_PART: Record<string, "subah" | "dopahar" | "shaam" | "raat"> = { صبح: "subah", دوپہر: "dopahar", شام: "shaam", رات: "raat" };
const PART_ANY = `${UR_PART_RE}|morning|evening|night|صبح|دوپہر|شام|رات`;

/** One reading inside a range ("11 pm", "raat 11", "صبح 7 بجے", "23:00"); `part` from the word next to it. */
function rangeClock(h: string, mi: string | undefined, suffix: string | undefined, part: string | undefined): string | null {
  const hour = Number(h);
  const minute = mi ? Number(mi) : 0;
  if (minute >= 60) return null;
  const s = suffix?.toLowerCase().replace(/\./g, "");
  if (s === "am" || s === "pm") {
    if (hour < 1 || hour > 12) return null;
    return formatClock((hour % 12) + (s === "pm" ? 12 : 0), minute);
  }
  const p = part?.toLowerCase();
  const named = p ? (UR_SCRIPT_PART[p] ?? urduPart(p === "morning" ? "subah" : p === "evening" ? "shaam" : p === "night" ? "raat" : p)) : null;
  if (!named) return hour <= 23 && (hour >= 13 || hour === 0 || mi !== undefined) ? formatClock(hour, minute) : null;
  const h24 = urduHour(hour, named);
  return h24 === null ? null : formatClock(h24, minute);
}

/**
 * A start–end clock range: "from 11 PM to 7 AM", "10pm-6am", "raat 11 se subah 7 tak", "رات 11 سے صبح 7 تک".
 * Null unless both ends are clear (the time lives in each end, never guessed by the LLM).
 */
export function extractTimeRange(text: string): { start: string; end: string } | null {
  const t = text.replace(/\s+/g, " ").trim();
  const end = `(?:(${PART_ANY})\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?|baje|bje|بجے)?(?:\\s+(${PART_ANY}))?`;
  const re = new RegExp(`${end}\\s*(?:-|–|to|till|until|se|سے)\\s*${end}`, "i");
  const m = re.exec(t);
  if (!m) return null;
  const [, p1, h1, m1, s1, q1, p2, h2, m2, s2, q2] = m;
  const isAmPm = (s: string | undefined) => Boolean(s && /^[ap]/i.test(s));
  // "10-11 PM" style: one suffix covers both ends (the existing range rule in extractTime).
  const suffixEnd = isAmPm(s2) ? s2 : undefined;
  const suffixStart = isAmPm(s1) ? s1 : !p1 && !q1 && suffixEnd ? (Number(h1) > Number(h2) && /^p/i.test(suffixEnd) ? "am" : suffixEnd) : undefined;
  const start = rangeClock(h1, m1, suffixStart, p1 ?? q1);
  const finish = rangeClock(h2, m2, suffixEnd, p2 ?? q2);
  return start && finish && start !== finish ? { start, end: finish } : null;
}

const UR_SCRIPT_DAYS: Array<{ re: RegExp; day: number }> = [
  { re: /اتوار/, day: 0 }, { re: /پیر|سوموار/, day: 1 }, { re: /منگل/, day: 2 }, { re: /بدھ/, day: 3 },
  { re: /جمعرات/, day: 4 }, { re: /جمعہ(?!رات)|جمعے/, day: 5 }, { re: /ہفتہ|ہفتے/, day: 6 },
];

/**
 * Days named for a routine change: "Mon Wed Fri", "on Mondays and Thursdays", "weekdays", "weekends",
 * "every day", "peer aur jumma", "پیر اور جمعہ". Null when none. ("hafta"/"ہفتہ" after "is/har/agle" is "week".)
 */
export function extractWeekdays(text: string): number[] | null {
  const t = text.toLowerCase();
  if (/\b(?:every\s*day|everyday|daily|roz|rozana|har roz)\b|ہر روز|روزانہ/.test(t)) return [0, 1, 2, 3, 4, 5, 6];
  if (/\bweekdays?\b|\bweek days\b/.test(t)) return [1, 2, 3, 4, 5];
  if (/\bweekends?\b/.test(t)) return [0, 6];
  const days = new Set<number>();
  for (const m of t.matchAll(new RegExp(`\\b${WEEKDAY_RE}s?\\b`, "gi"))) {
    const d = WEEKDAY_NAMES[m[1].toLowerCase()];
    if (d !== undefined) days.add(d);
  }
  for (const m of t.matchAll(new RegExp(`(?<!\\b(?:is|iss|har|agle|agla|pichle|next|this)\\s)\\b${UR_WEEKDAY_RE}\\b`, "gi"))) {
    const hit = UR_WEEKDAY_TESTS.find((w) => w.re.test(m[1]));
    if (hit) days.add(hit.day);
  }
  const ur = t.replace(/(?:اس|ہر|اگلے|پچھلے)\s+ہفت[ہے]/g, " ");
  for (const { re, day } of UR_SCRIPT_DAYS) if (re.test(ur)) days.add(day);
  return days.size ? [...days].sort((a, b) => a - b) : null;
}

/**
 * Target day of a command ("move everything to Friday", "سارے کام کل کر دو"): extractEntities' date, else
 * Urdu-script آج / کل / پرسوں (کل read forward, as a command target is never in the past). Kept out of
 * extractEntities so task and mood parsing of Urdu text does not change.
 */
export function extractTargetDay(text: string, opts: ExtractOptions): string | null {
  const e = extractEntities(text, opts);
  if (e.date) return e.date.ymd;
  const m = /(?:^|\s)(پرسوں|آج|کل)(?=\s|$|[،۔؟!])/.exec(text);
  if (!m) return null;
  return addDaysYmd(localYmd(opts.now, opts.tz), m[1] === "آج" ? 0 : m[1] === "کل" ? 1 : 2);
}

export type LocationCommand = { kind: "remove"; taskRef: string } | { kind: "change"; taskRef: string; place: string | null };

/** "remove the location (from X)", "X ki location hata do", "change the location (of X) to Y", "jagah badal do". */
/** "Ok", "so", "also" … before a command: not part of it ("Ok change the location to KFC Gulberg"). */
const COMMAND_LEAD_IN = /^(?:(?:ok(?:ay)?|k|so|also|and|then|now|yes|yeah|yep|alright|right|hey|hi|well|great|cool|fine|acha|achha|theek(?:\s+hai)?)[,!.\s]+)+/i;

export function parseLocationCommand(text: string): LocationCommand | null {
  const t = text.trim().replace(/[.!?]+$/, "").replace(COMMAND_LEAD_IN, "");
  let m = /^(?:please\s+)?(?:remove|delete|clear|drop)\s+(?:the\s+)?(?:location|place)(?:\s+(?:from|of|on)\s+(.+))?$/i.exec(t);
  if (m) return { kind: "remove", taskRef: (m[1] ?? "").trim() };
  m = /^(?:(.+?)\s+(?:ki|ka|ke|se)\s+)?(?:location|jagah)\s+(?:hata|hatao|hata\s*do|hata\s*dein|nikal\s*do)$/i.exec(t);
  if (m) return { kind: "remove", taskRef: (m[1] ?? "").trim() };
  m = /^(?:please\s+)?change\s+(?:the\s+)?(?:location|place)(?:\s+(?:of|for)\s+(.+?))?\s+to\s+(.+)$/i.exec(t);
  if (m) return { kind: "change", taskRef: (m[1] ?? "").trim(), place: m[2].trim() };
  m = /^(?:(.+?)\s+(?:ki|ka|ke)\s+)?(?:location|jagah)\s+(?:badal|badlo|change\s*kar)\s*(?:do|dein|den)?$/i.exec(t);
  if (m) return { kind: "change", taskRef: (m[1] ?? "").trim(), place: null };
  const lead = "^(?:(?:please|pls|let'?s|can you|could you|i want to|i'?d like to)\\s+)*";
  const loc = "(?:the\\s+|its\\s+|a\\s+|my\\s+|her\\s+|his\\s+)?(?:location|place)";
  // "set the location of groceries to Model Town", "add location for KFC task as Gulberg"
  m = new RegExp(`${lead}(?:change|set|update|put|add)\\s+${loc}\\s+(?:of|for|on)\\s+(.+?)\\s+(?:to|as|at)\\s+(.+)$`, "i").exec(t);
  if (m) return { kind: "change", taskRef: m[1].trim(), place: m[2].trim() };
  // "change its location to KFC Gulberg", "set location to Kalma Chowk"
  m = new RegExp(`${lead}(?:change|set|update|put|move)\\s+${loc}\\s+(?:to|as|at)\\s+(.+)$`, "i").exec(t);
  if (m) return { kind: "change", taskRef: "", place: m[1].trim() };
  // "add location of Kalma Chowk Gulberg", "check for location of KFC Gulberg", "search location KFC Gulberg"
  m = new RegExp(`${lead}(?:add|set|use|put|try|check(?:\\s+for)?|search(?:\\s+for)?|find|look\\s+for)\\s+${loc}\\s+(?:of|for|at|as|to|:)?\\s*(.+)$`, "i").exec(t);
  if (m) return { kind: "change", taskRef: "", place: m[1].trim() };
  // "use KFC Gulberg as the location"
  m = new RegExp(`${lead}(?:add|set|use|make)\\s+(.+?)\\s+(?:as|the)\\s+${loc}$`, "i").exec(t);
  if (m) return { kind: "change", taskRef: "", place: m[1].trim() };
  // A task named up front: "2nd task from today, change its location to KFC Gulberg".
  m = /^(.+?)\s*[,:;–-]\s+(.+)$/.exec(t);
  if (m) {
    const rest = parseLocationCommand(m[2]);
    if (rest && !rest.taskRef) return { ...rest, taskRef: m[1].trim() };
  }
  return null;
}

const FILLER_PREFIX =
  /^(?:(?:hey|hi|ok|okay|so|um|uh|well|please|pls|plz|let'?s|i said|i told you)[,!\s]+)*(?:(?:can|could|would|will) you\s+|(?:i|we)\s+(?:need|have|want|got|must|should|gotta|wanna)\s+(?:to\s+)?|(?:i|we)'?ll\s+|(?:i|we)\s+will\s+|(?:i'?m|we'?re|we\s+are|i\s+am)\s+going\s+to\s+|let\s+us\s+|remind\s+(?:me|us)\s+(?:to\s+|about\s+)?|don'?t\s+(?:let\s+me\s+)?forget\s+(?:to\s+|about\s+)?|remember\s+to\s+|add\s+(?:a\s+)?(?:new\s+)?(?:task|todo|to-do|reminder)\s*(?:to|for|about|:)?\s*|create\s+(?:a\s+)?(?:new\s+)?(?:task|todo|reminder)\s*(?:to|for|about|:)?\s*|set\s+(?:a\s+)?reminder\s*(?:to|for|about)?\s*|make\s+(?:a\s+)?(?:task|note)\s*(?:to|for|about)?\s*|schedule\s+|plan\s+(?:to\s+)?|task\s*:\s*|todo\s*:\s*)+/i;

/** Turns the residual text into a short actionable title. */
/**
 * Clause left dangling after its duration/date was extracted: ", it will take", "which",
 * "and it'll take about", "- takes", "tak". Only matched after a comma/dash or a connector word,
 * so real titles ending in "will" or "that" ("Update my will") are kept.
 */
const DANGLING_CLAUSE =
  /(?:\s*[,;:–—-]\s*|\s+(?:and|which|that|it)\s+|\s+(?=(?:which|that)\s*$))(?:(?:and|which|that)\s+)?(?:it\s*(?:'ll|will|should|would|might|may|is going to|is gonna)?|it'll|should|would|will|might|may|which|that)?(?:\s+(?:probably|likely))?(?:\s*(?:take|takes|need|needs|last|lasts|be))?(?:\s+(?:about|around|roughly|approx(?:imately)?))?\s*$/i;
/** Roman Urdu connectors left after the date/duration: "Friday tak", "… lagenge". */
const DANGLING_URDU = /\s+(?:tak|lagenge|lagega|lagegi|lagein\s*ge)\s*$/i;

export function cleanTitle(residual: string): string {
  let t = residual.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i += 1) t = t.replace(FILLER_PREFIX, "").replace(/^i\s+(?:to\s+)?/i, "").trim();
  for (let i = 0; i < 3; i += 1) t = t.replace(/[\s,.;:!?–—-]+$/g, "").replace(DANGLING_CLAUSE, "").replace(DANGLING_URDU, "").trim();
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

/* ---- repeating every N days ----------------------------------------------------------------------- */

const ORDINAL_N: Record<string, number> = { second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7 };
const WORD_N: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };

/**
 * "every other day", "alternate day(s)", "alternative day(s)", "every 2nd/second day", "every 3 days" and the Roman
 * Urdu "har doosre din", "ek din chhor kar", "har teesre din": the number of days between repeats (2..30), or null.
 * Only these phrasings; others are not guessed. Urdu script is planned after the deadline.
 */
export function extractInterval(text: string): number | null {
  const t = text.toLowerCase();
  if (/\bevery\s+other\s+day\b/.test(t) || /\b(?:alternate|alternative)\s+days?\b/.test(t)) return 2;
  if (/\bhar\s+(?:doosre|dusre|doosray|dusray|dosre)\s+din\b/.test(t) || /\bek\s+din\s+(?:chhor|chor|chhod|chod)\s+(?:kar|ke)\b/.test(t)) return 2;
  if (/\bhar\s+(?:teesre|tisre|teesray|tisray)\s+din\b/.test(t)) return 3;
  let m = /\bevery\s+(\d{1,2})(?:st|nd|rd|th)\s+day\b/.exec(t) ?? /\bevery\s+(second|third|fourth|fifth|sixth|seventh)\s+day\b/.exec(t);
  if (m) return clampInterval(Number(m[1]) || ORDINAL_N[m[1]]);
  m = /\bevery\s+(\d{1,2}|two|three|four|five|six|seven)\s+days\b/.exec(t);
  if (m) return clampInterval(Number(m[1]) || WORD_N[m[1]]);
  return null;
}

function clampInterval(n: number): number | null {
  return n >= 2 && n <= 30 ? n : null;
}

/** The interval phrase removed (for the title): "I take medicine on every alternative day" → "I take medicine on". */
export function withoutInterval(text: string): string {
  return text
    .replace(/\bevery\s+other\s+day\b|\b(?:on\s+)?(?:every\s+)?(?:alternate|alternative)\s+days?\b/gi, " ")
    .replace(/\bhar\s+(?:doosre|dusre|doosray|dusray|dosre|teesre|tisre|teesray|tisray)\s+din\b|\bek\s+din\s+(?:chhor|chor|chhod|chod)\s+(?:kar|ke)\b/gi, " ")
    .replace(/\bevery\s+(?:\d{1,2}(?:st|nd|rd|th)?|second|third|fourth|fifth|sixth|seventh|two|three|four|five|six|seven)\s+days?\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * "I already took it today", "I have taken today's", "I have already taken medicine of today", Roman Urdu
 * "aaj ki le li hai": today's dose is done. The clause is also dropped from the title.
 */
const DONE_TODAY = /\b(?:i\s+)?(?:have\s+|i'?ve\s+)?(?:already\s+)?(?:took|taken|had|done|did)\b[^.!?,]*\btoday'?s?\b|\baaj\s+(?:ki|ka|ke|wali|wala)?\s*(?:\w+\s+)?(?:le\s+li|kha\s+li|kar\s+li|ho\s+gay[ai])\b/i;
/** "no reminder", "without a reminder", "don't remind me", "bina reminder", "reminder nahi chahiye". */
const NO_REMINDER = /\b(?:no|without(?: a| any)?|skip the|don'?t (?:need|want)(?: a| any)?)\s+reminders?\b|\bdon'?t remind me\b|\bbina reminder\b|\breminder\s+(?:nahi|nahin|mat|na)\b/i;
export function saysNoReminder(text: string): boolean {
  return NO_REMINDER.test(text);
}
/** The title without its "no reminder" clause ("Meditate, no reminder" → "Meditate"). */
export function withoutNoReminder(title: string): string {
  return title.replace(new RegExp(`[\\s,;.-]*(?:${NO_REMINDER.source})(?:\\s+chahiye)?[\\s,;.!-]*`, "gi"), " ").replace(/\s+([,.])/g, "$1").replace(/[\s,;.-]+$/, "").trim();
}

export function saysDoneToday(text: string): boolean {
  return DONE_TODAY.test(text);
}
export function withoutDoneToday(text: string): string {
  return text
    .split(/(?:[,.;!?]|\s+and\s+|\s+aur\s+)/i)
    .filter((clause) => !DONE_TODAY.test(clause))
    .join(", ")
    .replace(/[,\s]+$/, "")
    .trim();
}

