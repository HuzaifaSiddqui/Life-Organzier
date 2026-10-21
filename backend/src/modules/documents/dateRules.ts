import { addDaysYmd, weekdayOfYmd } from "../../lib/time.js";
import { extractEntities, type DateEntity } from "../assistant/entities.js";

/**
 * Document-specific date rules (FR-DP-002). Dates themselves are still read by assistant/entities.ts; these
 * rules prepare the text for it (OCR slips, Urdu month names, "Sep."), add what a single sentence can't know
 * (the document's year, its semester start, ranges, records split over lines, table columns) and never invent
 * a date: a week number without a semester start stays undated for review.
 */

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const MONTH_ONLY = new RegExp(`^${MONTH}$`, "i");
const URDU_MONTHS: Record<string, string> = {
  جنوری: "January", فروری: "February", مارچ: "March", اپریل: "April", مئی: "May", جون: "June",
  جولائی: "July", اگست: "August", ستمبر: "September", اکتوبر: "October", نومبر: "November", دسمبر: "December",
};
/** Urdu words that mark an academic item, read as their English equivalent so the rules see them. */
const URDU_ACTIVITY: Record<string, string> = { اسائنمنٹ: "assignment", امتحان: "exam", کوئز: "quiz", پراجیکٹ: "project", پروجیکٹ: "project", مڈٹرم: "midterm", فائنل: "final" };
export const URDU_ACTIVITY_RE = new RegExp(Object.keys(URDU_ACTIVITY).join("|"));
const ACTIVITY_WORDS = ["assignment", "homework", "midterm", "examination", "presentation", "submission", "project", "proposal", "report", "quiz", "final"];

/* ------------------------------------------------------------------ OCR slips */

/** O/o → 0 and I/l/| → 1 inside a day number; null unless the result is a day of the month. */
function fixDay(token: string): string | null {
  const d = token.replace(/[Oo]/g, "0").replace(/[Il|]/g, "1");
  return /^\d{1,2}$/.test(d) && Number(d) >= 1 && Number(d) <= 31 ? d : null;
}

/** 0 → o, rn → m, 1/l/| → l inside a month word; null unless the result is a month name. */
function fixMonth(token: string): string | null {
  if (MONTH_ONLY.test(token)) return token;
  const m = token.toLowerCase().replace(/0/g, "o").replace(/rn/g, "m").replace(/[1|]/g, "l");
  if (!MONTH_ONLY.test(m)) return null;
  return m.charAt(0).toUpperCase() + m.slice(1);
}

/**
 * Repairs common OCR slips, but only inside date-like tokens ("0ct 12" → "Oct 12", "l2 Nov" → "12 Nov",
 * "2O Dec" → "20 Dec", "Decernber" → "December", "1 1: 59 PM" → "11:59 PM") and in activity words
 * ("Assignrnent" → "Assignment"). Other words are never touched.
 */
export function repairOcr(text: string): string {
  let t = text;
  // day + month: "l2 Nov", "2O Dec", "21 0ct", "10th Novernber"
  t = t.replace(/\b([0-9OoIl|]{1,2})(st|nd|rd|th)?(\s+(?:of\s+)?)([A-Za-z0-9|]{3,10})\b/g, (all, day: string, ord = "", gap: string, mon: string) => {
    const d = fixDay(day);
    const m = fixMonth(mon);
    // The day must hold a real digit ("I may" is not "1 May"), and something must actually be repaired.
    return d && m && /\d/.test(day) && (d !== day || m !== mon) ? `${d}${ord}${gap}${m}` : all;
  });
  // month + day: "0ct 12", "Nov l2", "Decernber 10"
  t = t.replace(/\b([A-Za-z0-9|]{3,10})(\.?\s+)([0-9OoIl|]{1,2})\b(?!:)/g, (all, mon: string, gap: string, day: string) => {
    const m = fixMonth(mon);
    const d = fixDay(day);
    return m && d && /\d/.test(day) && (m !== mon || d !== day) ? `${m}${gap}${d}` : all;
  });
  // numeric dates with a letter for a digit: "O7-11-2026", "2l/10/2026"
  t = t.replace(/\b([0-9OoIl]{1,2})([-/.])([0-9OoIl]{1,2})\2([0-9OoIl]{2,4})\b/g, (all, a: string, sep: string, b: string, y: string) => {
    if (!/[OoIl]/.test(all) || !/\d/.test(all)) return all;
    const fix = (s: string) => s.replace(/[Oo]/g, "0").replace(/[Il]/g, "1");
    return `${fix(a)}${sep}${fix(b)}${sep}${fix(y)}`;
  });
  // split clock digits: "1 1: 59 PM" → "11:59 PM"; "g AM" → "9 AM"
  t = t.replace(/\b(\d) (\d)\s?:\s?(\d{2})(\s*[ap]\.?m\b)/gi, "$1$2:$3$4").replace(/\b[gq](\s*[ap]\.?m\.?)(?=\W|$)/gi, "9$1");
  // activity words: "Assignrnent" → "Assignment"
  t = t.replace(/\b[A-Za-z]*rn[A-Za-z]*\b/g, (w) => (ACTIVITY_WORDS.includes(w.toLowerCase().replace(/rn/g, "m")) ? w.replace(/rn/g, "m") : w));
  return t;
}

/** Text prepared for entities.ts: OCR repair, Urdu months and activity words, "Sep." → "Sep", "agle Monday" → "next Monday". */
export function normalizeDocumentText(text: string): string {
  let t = repairOcr(text);
  for (const [ur, en] of Object.entries(URDU_MONTHS)) t = t.replace(new RegExp(ur, "g"), en);
  t = t.replace(new RegExp(`\\b(${MONTH})\\.(?=\\s*\\d)`, "gi"), "$1");
  t = t.replace(/\b(?:agle|agla|aglay|agli)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, "next $1");
  return t;
}

/** Adds the English activity word next to an Urdu one so the activity rules match ("اسائنمنٹ" → "اسائنمنٹ assignment"). */
export function urduActivityHint(line: string): string | null {
  const m = URDU_ACTIVITY_RE.exec(line);
  return m ? URDU_ACTIVITY[m[0]] : null;
}

/* ------------------------------------------------------------------ year */

export function hasExplicitYear(dateText: string): boolean {
  return /\b(?:19|20)\d{2}\b|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b|'\d{2}\b/.test(dateText);
}

/** True when the date names a month or is numeric (not "next Monday" / "parson", which are relative to today). */
function isCalendarDate(dateText: string): boolean {
  return new RegExp(`\\b${MONTH}\\b`, "i").test(dateText) || /\b\d{1,2}[-/.]\d{1,2}\b/.test(dateText);
}

export type YearContext = { yearFor(month: number): number | null; source: string | null };

/**
 * The year the document is about: its term ("Fall 2026": Aug–Dec 2026, Jan–Jul 2027) or else the years of its
 * other full dates (the month-weighted middle). A date without a year takes that year instead of "next occurrence".
 */
export function documentYear(text: string, now: Date, tz: string): YearContext {
  const term = /\b(fall|autumn|spring|summer|winter)\s*[-'’]?\s*((?:20)?\d{2})\b/i.exec(text);
  if (term) {
    const y = Number(term[2].length === 2 ? `20${term[2]}` : term[2]);
    const season = term[1].toLowerCase();
    return {
      source: term[0],
      yearFor: (m) => (season === "fall" || season === "autumn" ? (m >= 8 ? y : y + 1) : season === "winter" ? (m >= 10 ? y : y + 1) : y),
    };
  }
  const stamps: number[] = [];
  for (const line of text.split("\n")) {
    const e = extractEntities(line, { now, tz });
    if (e.date && hasExplicitYear(e.date.text) && isCalendarDate(e.date.text)) {
      const [y, m] = e.date.ymd.split("-").map(Number);
      stamps.push(y * 12 + (m - 1));
    }
  }
  if (!stamps.length) return { source: null, yearFor: () => null };
  const mid = [...stamps].sort((a, b) => a - b)[Math.floor(stamps.length / 2)];
  return {
    source: "other dates in the document",
    // The year that puts this month closest to the middle of the document's dates.
    yearFor: (m) => {
      const base = Math.floor(mid / 12);
      return [base - 1, base, base + 1].map((y) => ({ y, d: Math.abs(y * 12 + (m - 1) - mid) })).sort((a, b) => a.d - b.d)[0].y;
    },
  };
}

/** entities.ts date with the document's year applied when the text gave none. */
export function withDocumentYear(date: DateEntity, ctx: YearContext): { ymd: string; inferred: boolean } {
  if (hasExplicitYear(date.text) || !isCalendarDate(date.text)) return { ymd: date.ymd, inferred: false };
  const [, mm, dd] = date.ymd.split("-");
  const year = ctx.yearFor(Number(mm));
  // inferred: the date had no year and the document supplied it (even when "next occurrence" would agree).
  return year ? { ymd: `${year}-${mm}-${dd}`, inferred: true } : { ymd: date.ymd, inferred: false };
}

/* ------------------------------------------------------------------ semester weeks */

const START_PATTERNS = [
  /\b(?:semester|term|session|classes|lectures|teaching)\s+(?:starts?|begins?|commences?|start date)\s*(?:on|from|:|-)?\s*([^\n]{3,40})/i,
  /\b(?:start date|commencement of classes|first day of classes|classes commence)\s*(?:on|:|-)?\s*([^\n]{3,40})/i,
  /\bweek\s*0?1\b\s*[:(\-–]\s*(?:\w+day,?\s*)?([^)\n]{3,30})/i,
];

/** The semester's first day as written in the document (with its year), or null. */
export function semesterStart(text: string, now: Date, tz: string, year: YearContext): string | null {
  for (const re of START_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const e = extractEntities(m[1], { now, tz });
    if (e.date && isCalendarDate(e.date.text)) return withDocumentYear(e.date, year).ymd;
  }
  return null;
}

export const WEEK_RE = /\b(?:week|wk)\s*#?\s*(\d{1,2})\b/i;

/** Monday of week `n` when week 1 contains `startYmd`. */
export function weekToDate(n: number, startYmd: string): string {
  const monday = addDaysYmd(startYmd, -((weekdayOfYmd(startYmd) + 6) % 7));
  return addDaysYmd(monday, (n - 1) * 7);
}

/* ------------------------------------------------------------------ ranges */

/**
 * "20–24 Oct 2026", "7 to 11 December", "Nov 23 - Nov 25, 2026", "20/10/2026 - 24/10/2026": the line with
 * the range replaced by its END (the deadline) and the start kept for the source note.
 */
export function rangeToEnd(line: string): { line: string; start: string | null } {
  const sep = "\\s*(?:-|–|—|to|till|until|thru|through)\\s*";
  const ord = "(?:st|nd|rd|th)?";
  let m = new RegExp(`\\b(\\d{1,2})${ord}${sep}(\\d{1,2})${ord}\\s+(?:of\\s+)?(${MONTH})\\.?(,?\\s+\\d{2,4})?`, "i").exec(line);
  if (m) return { line: line.replace(m[0], `${m[2]} ${m[3]}${m[4] ?? ""}`), start: `${m[1]} ${m[3]}${m[4] ?? ""}` };
  m = new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{1,2})${ord}${sep}(?:(${MONTH})\\.?\\s+)?(\\d{1,2})${ord}\\b(,?\\s*\\d{4})?`, "i").exec(line);
  if (m) return { line: line.replace(m[0], `${m[3] ?? m[1]} ${m[4]}${m[5] ?? ""}`), start: `${m[1]} ${m[2]}${m[5] ?? ""}` };
  m = /\b(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\s*(?:-|–|—|to|till|until)\s*(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\b/i.exec(line);
  if (m) return { line: line.replace(m[0], m[2]), start: m[1] };
  return { line, start: null };
}

/* ------------------------------------------------------------------ multi-line records */

const LABEL = /^(?:date|due|due date|deadline|time|timing|venue|room|subject|course|paper|day|last date|submission|on|at|starts?|reporting time)\s*[:\-–]\s*(.*)$/i;
const DATE_ONLY = new RegExp(`^(?:\\w+day,?\\s*)?(?:\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}|${MONTH}\\.?\\s+\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4})`, "i");

export type DocRecord = { text: string; head: string; subject: string | null; lines: number };

/**
 * Joins a heading with the labelled lines under it ("Midterm Exam / Date: 15 Nov / Time: 10 AM") into one
 * record. `isHead` says which lines start a record (an activity or event without a date of its own).
 */
export function joinRecords(lines: string[], isHead: (line: string) => boolean, hasDate: (line: string) => boolean): DocRecord[] {
  const out: DocRecord[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!isHead(line) || hasDate(line)) {
      out.push({ text: line, head: line, subject: null, lines: 1 });
      continue;
    }
    const parts = [line];
    let subject: string | null = null;
    let j = i + 1;
    for (let blanks = 0; j < lines.length && parts.length <= 5; j += 1) {
      const next = lines[j].trim();
      // OCR puts a blank line between lines: one blank line doesn't end the record, two in a row do.
      if (!next) {
        if ((blanks += 1) > 1 || !lines[j + 1]?.trim()) break;
        continue;
      }
      blanks = 0;
      if (isHead(next) && !LABEL.test(next)) break;
      const label = LABEL.exec(next);
      if (label) {
        if (/^(?:subject|course|paper)\b/i.test(next)) subject = label[1].trim() || null;
        if (!label[1].trim() && j + 1 < lines.length && lines[j + 1].trim()) {
          parts.push(`${next} ${lines[j + 1].trim()}`); // "Date:" then the value on the next line
          j += 1;
        } else parts.push(next);
      } else if (DATE_ONLY.test(next)) parts.push(next);
      else break;
    }
    if (parts.length === 1) {
      out.push({ text: line, head: line, subject: null, lines: 1 });
      continue;
    }
    out.push({ text: parts.join(" — "), head: line, subject, lines: parts.length });
    i = j - 1;
  }
  return out;
}

/* ------------------------------------------------------------------ tables */

const DAY_NAMES: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const DATE_COL = /^(?:due|due date|due on|deadline|deadline date|date|submission(?: date)?|last date|exam date)$/i;
const TITLE_COL = /^(?:assignments?|items?|deliverables?|tasks?|activit(?:y|ies)|papers?|subjects?|courses?|exams?|titles?|names?|descriptions?|assessments?|components?|events?)$/i;
const TIME_COL = /^(?:time|timing|start time|starts)$/i;

function cells(line: string): { cells: string[]; sep: "pipe" | "tab" | "spaces" } | null {
  if (line.includes("|")) return { cells: line.split("|").map((c) => c.trim()), sep: "pipe" };
  if (line.includes("\t")) return { cells: line.split("\t").map((c) => c.trim()), sep: "tab" };
  const parts = line.trim().split(/\s{2,}/);
  return parts.length >= 2 ? { cells: parts, sep: "spaces" } : null;
}

export type TableRow = { title: string; date: string; time: string | null; line: string; examTable: boolean };
export type DayColumnCell = { title: string; day: number; time: string; line: string };

/**
 * Tables with a header row. "Assignment | Due | Weight" maps each row's title and date columns (and a time
 * column if there is one); "Time | Monday | Tuesday" is a timetable whose cells are classes on that day.
 * Returns the rows and the indexes of the lines they used, so the sentence rules skip them.
 */
export function readTables(lines: string[]): { rows: TableRow[]; classes: DayColumnCell[]; used: Set<number> } {
  const rows: TableRow[] = [];
  const classes: DayColumnCell[] = [];
  const used = new Set<number>();
  for (let i = 0; i < lines.length; i += 1) {
    const head = cells(lines[i]);
    if (!head || head.cells.filter(Boolean).length < 2) continue;
    const names = head.cells.map((c) => c.replace(/[:*]+$/, "").trim());
    const dayCols = names.map((n) => DAY_NAMES[n.toLowerCase()]).map((d, k) => (d !== undefined ? k : -1)).filter((k) => k >= 0);
    const timeCol = names.findIndex((n) => /^(?:time|timing|period|slot|timings)$/i.test(n));
    if (dayCols.length >= 2 && timeCol >= 0) {
      used.add(i);
      for (let j = i + 1; j < lines.length; j += 1) {
        if (!lines[j].trim() && lines[j + 1]?.trim()) continue; // OCR blank line inside the table
        const row = cells(lines[j]);
        if (!row || row.sep !== head.sep) break;
        used.add(j);
        const time = row.cells[timeCol];
        for (const k of dayCols) {
          const title = row.cells[k];
          if (title && time) classes.push({ title, day: DAY_NAMES[names[k].toLowerCase()], time, line: lines[j] });
        }
      }
      continue;
    }
    const dateCol = names.findIndex((n) => DATE_COL.test(n));
    if (dateCol < 0) continue;
    let titleCol = names.findIndex((n) => TITLE_COL.test(n));
    if (titleCol < 0) titleCol = names.findIndex((n, k) => k !== dateCol && n && !TIME_COL.test(n) && !/^(?:day|weight|marks?|%|weightage|points)$/i.test(n));
    if (titleCol < 0) continue;
    const timeIdx = names.findIndex((n) => TIME_COL.test(n));
    const examTable = /\b(?:paper|exam|date ?sheet)\b/i.test(`${lines[i - 1] ?? ""} ${names.join(" ")}`);
    let taken = 0;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (!lines[j].trim() && lines[j + 1]?.trim()) continue; // OCR blank line inside the table
      const row = cells(lines[j]);
      if (!row || row.sep !== head.sep || !row.cells[dateCol]) break;
      used.add(j);
      taken += 1;
      rows.push({ title: row.cells[titleCol] ?? "", date: row.cells[dateCol], time: timeIdx >= 0 ? row.cells[timeIdx] || null : null, line: lines[j], examTable });
    }
    if (taken) used.add(i);
  }
  return { rows, classes, used };
}

/* ------------------------------------------------------------------ Roman Urdu / Urdu weekdays */

const UR_DAYS: Array<{ re: RegExp; day: number }> = [
  { re: /^(?:peer|pir|somwaa?r|سوموار|پیر)(?=[\s,:|-]|$)/i, day: 1 },
  { re: /^(?:mangal(?:waa?r)?|منگل)(?=[\s,:|-]|$)/i, day: 2 },
  { re: /^(?:budh(?:waa?r)?|بدھ)(?=[\s,:|-]|$)/i, day: 3 },
  { re: /^(?:jum[ea]ra{1,2}t|جمعرات)(?=[\s,:|-]|$)/i, day: 4 },
  { re: /^(?:jumm?(?:a|e|ah)|جمعہ)(?=[\s,:|-]|$)/i, day: 5 },
  { re: /^(?:hafta|hafte|ہفتہ)(?=[\s,:|-]|$)/i, day: 6 },
  { re: /^(?:(?:a?i|e)tt?waa?r|اتوار)(?=[\s,:|-]|$)/i, day: 0 },
];

/** A timetable line that starts with a Roman Urdu or Urdu weekday ("Peer subah 9 baje Calculus"). */
export function urduWeekdayStart(line: string): { day: number; rest: string } | null {
  const t = line.trim();
  for (const { re, day } of UR_DAYS) {
    const m = re.exec(t);
    if (m) return { day, rest: t.slice(m[0].length).replace(/^[\s:|,-]+/, "") };
  }
  return null;
}

