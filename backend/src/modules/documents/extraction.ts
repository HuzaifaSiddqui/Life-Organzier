import { RoutineFrequency } from "@prisma/client";
import { z } from "zod";
import { getAi } from "../../ai/llm.js";
import { formatClock } from "../../lib/time.js";
import { cleanTitle, extractEntities } from "../assistant/entities.js";

export type ExtractedDeadline = {
  index: number;
  title: string;
  activity: string;
  date: string | null;
  time: string | null;
  assumedTime: boolean;
  confidence: number;
  source: string;
};

export type ExtractedSchedule = {
  index: number;
  title: string;
  frequency: RoutineFrequency | null;
  daysOfWeek: number[];
  time: string | null;
  durationMinutes: number | null;
  room: string | null;
  instructor: string | null;
  confidence: number;
  source: string;
};

export type CourseInfo = {
  code: string | null;
  name: string | null;
  instructor: string | null;
  prerequisites: string[];
  topics: string[];
  objectives: string[];
  grading: Array<{ item: string; weight: number }>;
  resources: string[];
};

/** Removes OCR/PDF noise while keeping line structure (FR-DP-001 §4). */
export function cleanDocumentText(raw: string): string {
  const lines = raw.replace(/\r/g, "").split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim());
  const counts = new Map<string, number>();
  for (const l of lines) if (l) counts.set(l.toLowerCase(), (counts.get(l.toLowerCase()) ?? 0) + 1);
  const out: string[] = [];
  for (const l of lines) {
    if (/^(?:page\s*)?\d{1,3}(?:\s*(?:of|\/)\s*\d{1,3})?$/i.test(l)) continue;
    if (/^-+\s*\d+\s*-+$/.test(l)) continue;
    if (l && (counts.get(l.toLowerCase()) ?? 0) > 3 && l.length < 60) continue;
    if (!l && out[out.length - 1] === "") continue;
    out.push(l);
  }
  return out.join("\n").trim();
}

/**
 * Documents like tickets carry national ID and phone numbers that extraction never needs; mask them
 * before the text is stored or sent to the model. Dates and times are left untouched.
 */
export function maskPersonalNumbers(text: string): string {
  return text
    .replace(/(?<!\d)\d{5}-?\d{7}-?\d(?!\d)/g, "[CNIC]")
    .replace(/(?:\+92|0092|(?<!\d)0)[\s-]?3\d{2}[\s-]?\d{7}(?!\d)/g, "[PHONE]")
    .replace(/\+\d{1,3}[\s-]?\d{3,4}[\s-]?\d{3,4}[\s-]?\d{3,4}(?!\d)/g, "[PHONE]");
}

const ACTIVITY_RE = /\b(assignment|homework|quiz|exam|midterm|mid-term|final(?:\s+exam)?|project|presentation|report|lab(?:\s+report)?|submission|paper|essay|proposal|thesis|test|viva|deliverable)\b/i;
const CLASS_RE = /\b(lecture|class|lab|tutorial|seminar|section|recitation|course|session)\b/i;

function splitSentences(text: string): string[] {
  return text
    .split(/\n|(?<=[.;])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && s.length <= 300);
}

export function extractDeadlines(text: string, now: Date, tz: string): ExtractedDeadline[] {
  const out: ExtractedDeadline[] = [];
  const seen = new Set<string>();
  for (const sentence of splitSentences(text)) {
    const activity = sentence.match(ACTIVITY_RE);
    if (!activity) continue;
    const e = extractEntities(sentence, { now, tz });
    const fuzzyDate = !e.date && /\b(next|this)\s+(month|week|semester)|\bsoon\b|\blater\b/i.test(sentence);
    if (!e.date && !fuzzyDate) continue;
    if (e.frequency) continue;
    let title = cleanTitle(e.residual.replace(/\b(?:is\s+)?(?:due|deadline|on|by|at|will be held|scheduled for)\b/gi, " "))
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!title || title.length < 3) title = activity[1].charAt(0).toUpperCase() + activity[1].slice(1);
    if (title.length > 80) title = `${title.slice(0, 77).replace(/\s+\S*$/, "")}…`;
    let confidence = 60;
    if (e.date && !e.date.fuzzy) confidence += /\d/.test(e.date.text) ? 20 : 12;
    if (e.date?.fuzzy || fuzzyDate) confidence -= 15;
    if (e.time) confidence += 10;
    if (/\b(?:assignment|quiz|project|lab|homework)\s*#?\d+\b/i.test(sentence) || /\bfinal|midterm/i.test(sentence)) confidence += 8;
    if (/\bdue\b|\bdeadline\b|\bsubmit/i.test(sentence)) confidence += 2;
    const vague = !e.date || e.date.fuzzy;
    const assumedTime = !vague && !e.time;
    if (assumedTime) confidence = Math.min(confidence, 90);
    if (vague) confidence = Math.min(confidence, 45);
    confidence = Math.max(5, Math.min(99, confidence));
    const key = `${title.toLowerCase()}|${e.date?.ymd ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      index: out.length,
      title,
      activity: activity[1].toLowerCase(),
      date: vague ? null : (e.date?.ymd ?? null),
      time: e.time ?? (vague ? null : "11:59 PM"),
      assumedTime,
      confidence,
      source: sentence,
    });
  }
  return out.slice(0, 60);
}

const ROOM_RE = /\b(?:room|rm\.?|hall|lab|venue)\s*[:#-]?\s*([A-Z]?-?\d{1,4}[A-Z]?|[A-Z][\w-]{1,15})\b/i;
const INSTRUCTOR_RE =
  /\b(?:[Ii]nstructor|[Tt]eacher|[Ll]ecturer|[Tt]aught by|INSTRUCTOR)\s*:?\s*(?:(?:[Pp]rof(?:essor)?|[Dd]r|[Mm]r|[Mm]s|[Ss]ir|[Mm]adam)\.?\s+)?([A-Z][a-zA-Z]+(?:[ \t]+[A-Z][a-zA-Z]+){0,2})|\b(?:[Pp]rof(?:essor)?|[Dd]r)\.?\s+([A-Z][a-zA-Z]+(?:[ \t]+[A-Z][a-zA-Z]+){0,2})/;

function instructorOf(text: string): string | null {
  const m = text.match(INSTRUCTOR_RE);
  return m ? (m[1] ?? m[2] ?? null) : null;
}
const WEEKDAY_START = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b[:\s|,-]*/i;
const RANGE_RE = /(\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:-|–|to)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/gi;
const DAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function scheduleFrom(segment: string, now: Date, tz: string, forcedDay?: number): Omit<ExtractedSchedule, "index"> | null {
  const room = segment.match(ROOM_RE)?.[1] ?? null;
  const instructor = instructorOf(segment);
  const stripped = segment.replace(ROOM_RE, " ").replace(INSTRUCTOR_RE, " ");
  // Bare ranges like "10-11:30" mean daytime class hours — give them an AM/PM hint.
  const hinted = stripped.replace(/\b(\d{1,2})(?::(\d{2}))?\s*(?:-|–)\s*(\d{1,2}):(\d{2})\b(?!\s*(?:am|pm|a\.m|p\.m))/i, (_m, a, b, c, d) => {
    const endH = Number(c);
    const suffix = endH >= 8 && endH <= 11 ? "am" : endH === 12 || endH <= 7 ? "pm" : "";
    return `${a}${b ? `:${b}` : ""}-${c}:${d} ${suffix}`;
  });
  const e = extractEntities(hinted, { now, tz });
  const days = forcedDay !== undefined ? [forcedDay] : (e.daysOfWeek ?? []);
  const isClass = CLASS_RE.test(segment) || /\b[A-Z]{2,4}[-\s]?\d{3}\b/.test(segment) || forcedDay !== undefined;
  if (!days.length && !(isClass && e.time)) return null;
  if (!days.length && !e.time && !isClass) return null;
  let title = cleanTitle(e.residual.replace(/[|:]+/g, " ").replace(/\b(?:every|on|from|at)\b/gi, " ")).replace(/\s{2,}/g, " ");
  if (!title || title.length < 2) title = isClass ? "Class" : "Session";
  if (title.length > 80) title = `${title.slice(0, 77)}…`;
  let confidence = 55;
  if (days.length) confidence += 20;
  if (e.time) confidence += 15;
  if (e.durationMinutes) confidence += 5;
  if (title.length >= 4 && title !== "Class") confidence += 4;
  if (!days.length) confidence = 20;
  return {
    title,
    frequency: days.length ? (days.length === 7 ? RoutineFrequency.DAILY : RoutineFrequency.WEEKLY) : null,
    daysOfWeek: days,
    time: e.time,
    durationMinutes: e.durationMinutes,
    room,
    instructor,
    confidence: Math.min(99, confidence),
    source: segment,
  };
}

export function extractSchedules(text: string, now: Date, tz: string): ExtractedSchedule[] {
  const out: ExtractedSchedule[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const dayMatch = line.match(WEEKDAY_START);
    const ranges = line.match(RANGE_RE) ?? [];
    if (dayMatch && ranges.length >= 1 && !/\b(?:and|&|,|\/)\s*(?:mon|tue|wed|thu|fri|sat|sun)/i.test(line.slice(dayMatch[0].length, dayMatch[0].length + 12))) {
      // Timetable row: "Monday | 9:00-10:30 Calculus | 11:00-12:30 Physics"
      const day = DAY_INDEX[dayMatch[1].slice(0, 3).toLowerCase()];
      const rest = line.slice(dayMatch[0].length);
      const cells = rest.split(/\s*\|\s*|(?<![\d:])(?=\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:-|–|to)\s*\d{1,2})/i).map((c) => c.replace(/^[|,;\s]+|[|,;\s]+$/g, "")).filter((c) => c.length > 3);
      for (const cell of cells) {
        const s = scheduleFrom(cell, now, tz, day);
        if (s && s.time) out.push({ ...s, index: out.length });
      }
      continue;
    }
    if (!/\b(mon|tue|wed|thu|fri|sat|sun|weekday|daily|every|MWF|TTh|morning|evening)\w*/i.test(line)) continue;
    if (ACTIVITY_RE.test(line) && /\bdue|deadline|submit/i.test(line)) continue;
    const s = scheduleFrom(line, now, tz);
    if (s) out.push({ ...s, index: out.length });
  }
  return out.slice(0, 60);
}

function section(text: string, header: RegExp): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => header.test(l));
  if (start < 0) return [];
  const inline = lines[start].replace(header, "").replace(/^[\s:–-]+/, "").trim();
  const items: string[] = inline ? inline.split(/\s*[,;•]\s*/).filter((x) => x.length > 1) : [];
  for (let i = start + 1; i < lines.length && i < start + 25; i += 1) {
    const l = lines[i].trim();
    if (!l) {
      if (items.length) break;
      continue;
    }
    if (/^[A-Z][A-Za-z ]{2,40}:?$/.test(l) && !/^[-•*\d]/.test(l) && items.length) break;
    items.push(l.replace(/^(?:[-•*▪●]|\d+[.)]|week\s*\d+\s*[:-]?)\s*/i, "").trim());
  }
  return items.filter((x) => x.length > 1 && x.length < 140).slice(0, 20);
}

export function extractCourseInfo(text: string): CourseInfo {
  const code = text.match(/\b([A-Z]{2,4})[-\s]?(\d{3,4}[A-Z]?)\b/);
  const nameLine =
    text.match(/\b(?:course\s*(?:title|name)?|subject)\s*[:–-]\s*([^\n]{3,80})/i)?.[1] ??
    (code ? text.slice((code.index ?? 0) + code[0].length).split("\n")[0].replace(/^[\s:–-]+/, "").slice(0, 80) : null);
  const prereqLine = text.match(/\bpre-?requisites?\s*[:–-]?\s*([^\n]{2,160})/i)?.[1] ?? "";
  const prerequisites = prereqLine
    .split(/\s*(?:,|;|\band\b|&)\s*/i)
    .map((p) => p.trim().replace(/[.]$/, ""))
    .filter((p) => p.length > 1 && !/^none$/i.test(p))
    .slice(0, 6);
  const grading: Array<{ item: string; weight: number }> = [];
  for (const m of text.matchAll(/([A-Za-z][A-Za-z /&-]{2,30}?)\s*[:(–-]?\s*(\d{1,3})\s*%/g)) {
    const weight = Number(m[2]);
    const item = m[1].trim().replace(/\s+/g, " ");
    if (weight > 0 && weight <= 100 && !grading.some((g) => g.item.toLowerCase() === item.toLowerCase())) grading.push({ item, weight });
  }
  for (const m of text.matchAll(/(\d{1,3})\s*%\s+([A-Za-z][A-Za-z /&-]{2,30})/g)) {
    const weight = Number(m[1]);
    const item = m[2].trim().split(/\s*,\s*/)[0];
    if (weight > 0 && weight <= 100 && !grading.some((g) => g.item.toLowerCase() === item.toLowerCase())) grading.push({ item, weight });
  }
  return {
    code: code ? `${code[1]}${code[2]}` : null,
    name: nameLine?.trim() || null,
    instructor: instructorOf(text),
    prerequisites,
    topics: section(text, /\b(?:topics(?:\s+covered)?|course\s+(?:outline|contents?)|syllabus\s+outline|weekly\s+schedule)\b\s*:?/i),
    objectives: section(text, /\b(?:objectives|learning\s+outcomes|course\s+goals)\b\s*:?/i),
    grading: grading.slice(0, 10),
    resources: section(text, /\b(?:textbooks?|resources|references|reading\s+list|materials)\b\s*:?/i),
  };
}

const topicSchema = z.object({ topics: z.array(z.string().min(2).max(60)).max(10) });

/** Optional LLM pass to recover topics when the document has no clear "Topics" section. */
export async function llmTopics(text: string): Promise<string[]> {
  const result = await getAi().json(
    [
      { role: "system", content: "List the main learning topics covered in this course document (max 8, 1-4 words each). Return JSON {\"topics\": [...]}." },
      { role: "user", content: text.slice(0, 2500) },
    ],
    topicSchema,
    { json: { type: "object", properties: { topics: { type: "array", items: { type: "string" }, maxItems: 8 } }, required: ["topics"] }, maxTokens: 150, timeoutMs: 45000 },
  );
  return result?.topics ?? [];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const actionSchema = z.object({
  items: z
    .array(
      z.object({
        kind: z.string(),
        title: z.string().min(2).max(100),
        date: z.string(),
        time: z.string(),
        evidence: z.string(),
      }),
    )
    .max(10),
});

/** True when the document itself contains this date (day-first, month-first, ISO or month name). */
export function dateGrounded(ymd: string, text: string): boolean {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = text.toLowerCase();
  const day = String(d);
  const dd = day.padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  const numeric = [`${dd}-${mm}`, `${dd}/${mm}`, `${dd}.${mm}`, `${mm}-${dd}`, `${mm}/${dd}`, `${y}-${mm}-${dd}`, `${day}-${m}-`, `${day}/${m}/`, `${m}/${day}/`];
  if (numeric.some((s) => t.includes(s))) return true;
  const mon = MONTHS[m - 1];
  return new RegExp(`\\b0?${day}(?:st|nd|rd|th)?\\s+${mon}|\\b${mon}[a-z]*\\.?\\s+0?${day}\\b`).test(t);
}

/**
 * Fallback for documents the rules don't understand (tickets, invitations, bills, appointment
 * letters, notices…): the LLM proposes dated action items, and only items whose date really
 * appears in the document survive. Confidence stays below the auto-create threshold, so the user
 * always confirms them.
 */
export async function llmActionItems(text: string, todayYmd: string, tz: string): Promise<ExtractedDeadline[]> {
  if (text.replace(/\s+/g, "").length < 30) return [];
  const result = await getAi().json(
    [
      {
        role: "system",
        content: `You read documents (tickets, receipts, invitations, bills, notices, letters, schedules) and find things the reader must do or attend: travel departures, appointments, events, payments due, submissions, exams.
Return JSON {"items": [...]}; each item: kind (travel|appointment|event|payment|deadline|exam|task), title (short and specific, e.g. "Flight Karachi → Islamabad (PK-301)", "Dentist appointment"), date as YYYY-MM-DD, time as 24h HH:MM or "", evidence (the exact words from the document that contain the date).
Today is ${todayYmd} (timezone ${tz}). Numeric dates like 07-09-2026 are day-month-year unless clearly not. Only include items with a date written in the document. Ignore prices, IDs, phone numbers and fine print. If there is nothing to do, return {"items": []}.`,
      },
      { role: "user", content: text.slice(0, 3000) },
    ],
    actionSchema,
    {
      json: {
        type: "object",
        properties: {
          items: {
            type: "array",
            maxItems: 10,
            items: {
              type: "object",
              properties: { kind: { type: "string" }, title: { type: "string" }, date: { type: "string" }, time: { type: "string" }, evidence: { type: "string" } },
              required: ["kind", "title", "date", "time", "evidence"],
            },
          },
        },
        required: ["items"],
      },
      maxTokens: 500,
      timeoutMs: 60000,
    },
  );
  const out: ExtractedDeadline[] = [];
  for (const item of result?.items ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date) || Number.isNaN(Date.parse(item.date))) continue;
    if (!dateGrounded(item.date, text)) continue; // hallucinated or misread date
    const clock = item.time.match(/^(\d{1,2}):(\d{2})$/);
    out.push({
      index: out.length,
      title: cleanTitle(item.title) || item.title,
      activity: item.kind.toLowerCase(),
      date: item.date,
      time: clock && Number(clock[1]) < 24 ? formatClock(Number(clock[1]), Number(clock[2])) : null,
      assumedTime: false,
      confidence: 85,
      source: item.evidence.slice(0, 200) || "AI reading",
    });
  }
  return out;
}
