import { Priority } from "@prisma/client";
import { z } from "zod";
import { getAi } from "../../ai/llm.js";
import { dateGrounded, sameItem, type CourseInfo, type ExtractedDeadline, type ExtractedSchedule } from "./extraction.js";
import { weekdayLabels } from "./gridTimetable.js";

/**
 * Document routing and checks (docs/known-limitations.md → Documents). Every behaviour here is off unless its flag is
 * "on": DOC_FALLBACK_UI, DOC_ROUTING, DOC_PRIORITY_V2, DOC_EVIDENCE, DOC_LAYOUT, DOC_AGREE. Off = the reader as before.
 */
export type DocFlag = "DOC_FALLBACK_UI" | "DOC_ROUTING" | "DOC_PRIORITY_V2" | "DOC_EVIDENCE" | "DOC_LAYOUT" | "DOC_AGREE";
export const docFlag = (name: DocFlag): boolean => process.env[name]?.toLowerCase() === "on";

export const DOC_KINDS = ["timetable", "schedule", "notice", "assignment", "other"] as const;
export type DocKind = (typeof DOC_KINDS)[number];
/** Shown in review ("Read as: date sheet / outline"). */
export const DOC_KIND_LABELS: Record<DocKind, string> = {
  timetable: "Timetable",
  schedule: "Schedule, outline or date sheet",
  notice: "Notice",
  assignment: "Assignment or exam sheet",
  other: "Other",
};
export type KindResult = { kind: DocKind; confidence: number; via: "rules" | "model" | "user" };

/** Below this the rules are unsure and the model is asked (when AI is on). */
export const KIND_SURE = 0.75;

const CLOCK_RANGE = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:-|–|to)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi;
const MON = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
/** A line that mentions a calendar date (the type check counts these too: the deadline rules may not read every format). */
const DATE_LINE = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?[\\s-]+(?:of\\s+)?(?:${MON})|\\b(?:${MON})[a-z]*\\.?\\s+\\d{1,2}\\b|\\b\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b`, "i");

/**
 * Document type from the rules: what the readers found plus a few words. Deterministic; `confidence` < KIND_SURE
 * means "unsure" (the model may be asked).
 */
export function kindByRules(text: string, found: { deadlines: ExtractedDeadline[]; schedules: ExtractedSchedule[]; grid: boolean }): KindResult {
  const t = text.toLowerCase();
  const dated = Math.max(found.deadlines.filter((d) => d.date).length, text.split("\n").filter((l) => DATE_LINE.test(l)).length);
  const days = weekdayLabels(text).size;
  const clocks = (text.match(CLOCK_RANGE) ?? []).length;
  const r = (kind: DocKind, confidence: number): KindResult => ({ kind, confidence, via: "rules" });
  if (found.grid || (found.schedules.length >= 3 && dated <= 1) || (days >= 3 && clocks >= 3 && dated <= 1)) return r("timetable", found.grid ? 0.95 : 0.85);
  if (/\b(?:date ?sheet|course (?:outline|schedule)|syllabus|academic calendar|week\s*\d{1,2}\b)/.test(t) && dated >= 2) return r("schedule", 0.9);
  if (dated >= 4) return r("schedule", 0.8);
  const workWord = /\b(?:assignment|homework|project|lab report|quiz|exam(?:ination)?|test|viva|presentation)\b/.test(t);
  const dueWord = /\b(?:due|deadline|submi(?:t|ssion)|last date|will be held|scheduled)\b/.test(t);
  if (workWord && dueWord && dated >= 1 && dated <= 3) return r("assignment", 0.85);
  if (/\b(?:notice|notification|announcement|circular|invitation|you are invited|is hereby|hereby informed)\b/.test(t) && dated >= 1 && dated <= 3) return r("notice", 0.85);
  if (dated === 0 && !found.schedules.length) return r("other", 0.8);
  // Something was found but no type word says what the document is.
  if (workWord && dated >= 1) return r("assignment", 0.6);
  if (dated >= 2) return r("schedule", 0.6);
  return r(dated === 1 ? "notice" : "other", 0.5);
}

const kindSchema = z.object({ kind: z.enum(DOC_KINDS) });

/** The rules first; the model (masked text, start of the document) only when they are unsure and AI is on. */
export async function classifyDocument(text: string, found: Parameters<typeof kindByRules>[1], timeoutMs = 15000): Promise<KindResult> {
  const rules = kindByRules(text, found);
  if (rules.confidence >= KIND_SURE) return rules;
  const ai = getAi();
  if (!ai.enabled || !ai.available) return rules;
  const answer = await ai.json(
    [
      {
        role: "system",
        content: `Classify a student's document. Reply JSON {"kind": one of ${DOC_KINDS.map((k) => `"${k}"`).join(", ")}}.
timetable = weekly classes by day and time; schedule = course outline, semester schedule or exam date sheet (many dates); notice = one announcement or event; assignment = one assignment, project or exam with its due date; other = anything else (notes, tickets, bills, letters).`,
      },
      { role: "user", content: text.slice(0, 2000) },
    ],
    kindSchema,
    { json: { type: "object", properties: { kind: { type: "string", enum: [...DOC_KINDS] } }, required: ["kind"] }, maxTokens: 20, timeoutMs },
  );
  return answer ? { kind: answer.kind, confidence: 0.75, via: "model" } : rules;
}

/** Highest confidence that is still never auto-created (just below the gates in documentProcessing.ts). */
const REVIEW_DEADLINE = 94;
const REVIEW_SCHEDULE = 89;
const toReview = (d: ExtractedDeadline): ExtractedDeadline => ({ ...d, review: true, confidence: Math.min(d.confidence, REVIEW_DEADLINE) });
const scheduleToReview = (s: ExtractedSchedule): ExtractedSchedule => ({ ...s, confidence: Math.min(s.confidence, REVIEW_SCHEDULE) });

/**
 * What each type may create automatically (DOC_ROUTING). Items the type doesn't create stay in review, so nothing is
 * lost: timetable → routines; schedule / outline / date sheet → deadlines; notice → its one best item; assignment /
 * exam → deadlines; other → nothing automatic (the text view and "Pick lines" are offered).
 */
export function routeItems(kind: DocKind, deadlines: ExtractedDeadline[], schedules: ExtractedSchedule[]): { deadlines: ExtractedDeadline[]; schedules: ExtractedSchedule[] } {
  switch (kind) {
    case "timetable":
      return { deadlines: deadlines.map(toReview), schedules };
    case "schedule":
    case "assignment":
      return { deadlines, schedules: schedules.map(scheduleToReview) };
    case "notice": {
      // One task or reminder: the most confident dated item; the rest are offered for review.
      const best = [...deadlines].filter((d) => d.date).sort((a, b) => b.confidence - a.confidence)[0];
      return { deadlines: deadlines.map((d) => (d === best ? d : toReview(d))), schedules: schedules.map(scheduleToReview) };
    }
    default:
      return { deadlines: deadlines.map(toReview), schedules: schedules.map(scheduleToReview) };
  }
}

/**
 * DOC_PRIORITY_V2: a documented score instead of "final|midterm|exam → HIGH, else MEDIUM".
 *   item type: final exam 3 · midterm / exam 2.5 · project / assignment / viva / presentation 1.5 · quiz / lab 1.2 · other 1
 *   days left (from today): ≤ 2 → +2 · ≤ 7 → +1 · ≤ 14 → +0.5
 *   weightage (marks or % on the item's line, else the course's grading table by title): ≥ 25% → +1.5 · ≥ 10% → +0.75
 *   score ≥ 4.5 URGENT · ≥ 3 HIGH · ≥ 1.5 MEDIUM · else LOW
 * Days left are counted at upload; the task keeps that priority (it is not re-scored later).
 */
export function documentPriority(d: Pick<ExtractedDeadline, "title" | "activity" | "date" | "source">, todayYmd: string, grading: CourseInfo["grading"] = []): { priority: Priority; score: number } {
  const words = `${d.activity} ${d.title}`.toLowerCase();
  let score = /\bfinal\b/.test(words) && /\bexam|paper|test\b/.test(words) ? 3 : /\b(?:midterm|mid-term|exam|examination)\b/.test(words) ? 2.5 : /\b(?:project|assignment|viva|presentation|report)\b/.test(words) ? 1.5 : /\b(?:quiz|lab)\b/.test(words) ? 1.2 : 1;
  if (d.date) {
    const days = Math.round((Date.parse(`${d.date}T00:00:00Z`) - Date.parse(`${todayYmd}T00:00:00Z`)) / 86400000);
    if (days >= 0) score += days <= 2 ? 2 : days <= 7 ? 1 : days <= 14 ? 0.5 : 0;
  }
  const line = d.source.toLowerCase();
  const pct = Number(line.match(/(\d{1,3})\s*%/)?.[1] ?? NaN);
  const marks = Number(line.match(/(\d{1,3})\s*marks?\b/)?.[1] ?? NaN);
  const graded = grading.find((g) => words.includes(g.item.toLowerCase().split(/\s+/)[0] ?? "\u0000"))?.weight;
  const weight = Number.isFinite(pct) ? pct : Number.isFinite(marks) ? marks : (graded ?? 0);
  score += weight >= 25 ? 1.5 : weight >= 10 ? 0.75 : 0;
  return { priority: score >= 4.5 ? Priority.URGENT : score >= 3 ? Priority.HIGH : score >= 1.5 ? Priority.MEDIUM : Priority.LOW, score };
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Levenshtein similarity 0..1. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

/** The document line the evidence comes from: exact containment, else the best fuzzy match of a same-length window. */
export function evidenceLine(evidence: string, text: string): { line: string; score: number } | null {
  const e = norm(evidence);
  if (e.length < 4) return null;
  let best: { line: string; score: number } | null = null;
  for (const raw of text.split("\n")) {
    const l = norm(raw);
    if (!l) continue;
    if (l.includes(e)) return { line: raw.trim(), score: 1 };
    const words = l.split(" ");
    const n = e.split(" ").length;
    for (let i = 0; i + Math.max(1, n - 1) <= words.length; i += 1) {
      for (const len of [n - 1, n, n + 1]) {
        if (len < 1 || i + len > words.length) continue;
        const s = similarity(e, words.slice(i, i + len).join(" "));
        if (!best || s > best.score) best = { line: raw.trim(), score: s };
      }
    }
  }
  return best;
}

/** Fuzzy threshold for "the line exists in the extracted text". */
export const EVIDENCE_MIN = 0.9;

/**
 * DOC_EVIDENCE: an AI item is verified only when its evidence is a line of the extracted text (≥ 0.9 similar) and its
 * date (and time, when it has one) can be read from that line. Unverified items stay in review, get no agreement
 * bonus and are never created automatically; the line is shown in the review row either way.
 */
export function verifyEvidence(item: ExtractedDeadline, text: string): ExtractedDeadline & { verified: boolean; evidence: string | null } {
  const hit = evidenceLine(item.source, text);
  const line = hit && hit.score >= EVIDENCE_MIN ? hit.line : null;
  const hour = item.time?.match(/^(\d{1,2})/)?.[1];
  const timeOk = !hour || new RegExp(`\\b0?${hour}(?::|\\s*(?:am|pm)|\\.|\\b)`, "i").test(line ?? "");
  const verified = Boolean(line && item.date && dateGrounded(item.date, line) && timeOk);
  return { ...item, verified, evidence: line ?? (item.source && item.source !== "AI reading" ? item.source : null), ...(verified ? {} : { review: true, confidence: Math.min(item.confidence, REVIEW_DEADLINE) }) };
}

/** DOC_AGREE: at most this many extra model calls (chunks) per document. */
export const AGREE_MAX_CALLS = 3;
/** Found by both models but not by the rules: more likely right, still never created automatically. */
export const AGREE_MAX = REVIEW_DEADLINE - 4;

/**
 * DOC_AGREE: when the type is "other" or OCR read under 70, a second model reads the same masked text (at most
 * AGREE_MAX_CALLS chunks). The second model is local by default (DOC_AGREE_MODEL, default qwen2.5:14b), so private
 * documents never leave the machine. AI-only items both models found get `modelsAgree` and confidence AGREE_MAX
 * (still below the auto-create gate); items only one found stay as they are (review). Rules items are unchanged:
 * only the rules can confirm an item for auto-creation.
 */
export async function agreeOnAiItems(
  deadlines: ExtractedDeadline[],
  second: () => Promise<ExtractedDeadline[]>,
): Promise<{ deadlines: Array<ExtractedDeadline & { modelsAgree?: boolean }>; secondItems: number }> {
  const other = await second().catch(() => []);
  const out = deadlines.map((d) => {
    if (!d.aiOnly) return d;
    const both = other.some((o) => o.date === d.date && sameItem(o.title, d.title));
    return both ? { ...d, modelsAgree: true, confidence: Math.max(d.confidence, AGREE_MAX) } : d;
  });
  return { deadlines: out, secondItems: other.length };
}

/**
 * DOC_FALLBACK_UI "Pick lines": review items from lines the user chose in the extracted text. A line must be in the
 * document (nothing typed in is trusted as "read"); its date comes from the rules or it stays undated. Never created
 * automatically: the user confirms them like any review item.
 */
export function itemsFromPickedLines(lines: string[], text: string, read: (line: string) => ExtractedDeadline[]): ExtractedDeadline[] | null {
  const have = new Set(text.split("\n").map(norm).filter(Boolean));
  if (lines.some((l) => !have.has(norm(l)))) return null;
  return lines.flatMap((line) => {
    const found = read(line);
    const title = line.trim().replace(/\s+/g, " ").slice(0, 80);
    return (found.length ? found : [{ index: 0, title, activity: "task", date: null, time: null, assumedTime: false, confidence: 50, source: line.trim() }]).map((d) => ({ ...d, review: true, confidence: Math.min(d.confidence, REVIEW_DEADLINE), source: line.trim() }));
  }).map((d, index) => ({ ...d, index }));
}
