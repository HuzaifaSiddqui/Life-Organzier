import { Priority } from "@prisma/client";
import { AiService } from "../../ai/ai.service.js";
import type { SemanticTaskExtraction } from "../../ai/providers/provider.interface.js";

export type ParsedTaskPreview = {
  title: string;
  description: string | null;
  dueDateText: string | null;
  dueTime: string | null;
  /** Single human-readable due line: date phrase · time */
  dueSummary: string | null;
  priority: Priority;
  category: string | null;
  confidence: number;
  needsConfirmation: boolean;
  priorityDetected: boolean;
  timeDetected: boolean;
  dueDateIso: string | null;
  /**
   * Resolved calendar day as YYYY-MM-DD in the client's timezone (matches manual date picker semantics).
   * Present when {@link ParsedTaskPreview.dueDateIso} refers to that day — mobile should prefer this field for saves/reminders.
   */
  dueDateYmd: string | null;
};

export type ParseTaskOptions = {
  /** Device "today"; when omitted, server local calendar is used (legacy). */
  clientTodayYmd?: string;
  /** ISO instant when the user tapped parse — required for correct "in X hours/minutes". */
  clientNowIso?: string;
  /** `Date#getTimezoneOffset()` from the device (UTC − local, minutes). Used with {@link ParseTaskOptions.clientNowIso}. */
  clientTimezoneOffsetMinutes?: number;
};

const PRIORITY_RULES: { words: RegExp; value: Priority }[] = [
  { words: /\b(urgent|very important|critical)\b/i, value: Priority.URGENT },
  { words: /\b(high|important)\b/i, value: Priority.HIGH },
  { words: /\b(medium|normal)\b/i, value: Priority.MEDIUM },
  { words: /\b(low|later)\b/i, value: Priority.LOW },
];

const CATEGORY_RULES: { words: RegExp; label: string }[] = [
  {
    words: /\b(assignment|quiz|exam|lecture|university|class)\b/i,
    label: "Academic",
  },
  { words: /\b(meeting|client|office|project)\b/i, label: "Work" },
  {
    words: /\b(gym|workout|doctor|medicine|sleep)\b/i,
    label: "Health",
  },
  { words: /\b(bill|payment|bank|budget)\b/i, label: "Finance" },
  { words: /\b(home|family|shopping)\b/i, label: "Personal" },
];

const DATE_PHRASES = [
  "next monday",
  "next tuesday",
  "next wednesday",
  "next thursday",
  "next friday",
  "next saturday",
  "next sunday",
  "this week",
  "next week",
  "today",
  "tomorrow",
] as const;

const TIME_PATTERNS: { re: RegExp; label: (m: RegExpMatchArray) => string }[] = [
  {
    re: /\b(\d{1,2}):(\d{2})\s*(?:a\.?\s*m\.?|p\.?\s*m\.?)\b/i,
    label: (m) => {
      const tail = m[0].toLowerCase().includes("p") ? "PM" : "AM";
      return `${m[1]}:${m[2]} ${tail}`;
    },
  },
  {
    re: /\b(\d{1,2})\s*(?:a\.?\s*m\.?|p\.?\s*m\.?)\b/i,
    label: (m) => {
      const tail = m[0].toLowerCase().includes("p") ? "PM" : "AM";
      return `${m[1]} ${tail}`;
    },
  },
  { re: /\b(\d{1,2}):(\d{2})\s*(am|pm)\b/i, label: (m) => `${m[1]}:${m[2]} ${m[3].toUpperCase()}` },
  { re: /\b(\d{1,2})\s*(am|pm)\b/i, label: (m) => `${m[1]} ${m[2].toUpperCase()}` },
  { re: /\b(\d{1,2}):(\d{2})\b/, label: (m) => `${m[1]}:${m[2]}` },
  { re: /\b(morning|afternoon|evening|night)\b/i, label: (m) => m[1].toLowerCase() },
];

/** ---- Calendar helpers (timezone-neutral YMD arithmetic; anchored to client's "today"). ---- */
function splitYmd(ymd: string): { y: number; mo: number; da: number } | null {
  const m = ymd.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  const chk = new Date(Date.UTC(y, mo - 1, da));
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== da) return null;
  return { y, mo, da };
}

function fmtYmd(y: number, mo: number, da: number): string {
  return `${y}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
}

function serverLocalTodayYmd(): string {
  const d = new Date();
  return fmtYmd(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function resolveAnchorYmd(opts?: ParseTaskOptions): string {
  if (opts?.clientTodayYmd) {
    const p = splitYmd(opts.clientTodayYmd);
    if (p) return opts.clientTodayYmd.trim();
  }
  return serverLocalTodayYmd();
}

function addDaysToYmd(ymd: string, n: number): string | null {
  const p = splitYmd(ymd);
  if (!p) return null;
  const u = new Date(Date.UTC(p.y, p.mo - 1, p.da) + n * 86400000);
  return fmtYmd(u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate());
}

function utcNoonIsoFromYmd(ymd: string): string | null {
  const p = splitYmd(ymd);
  if (!p) return null;
  return new Date(Date.UTC(p.y, p.mo - 1, p.da, 12, 0, 0)).toISOString();
}

function weekdaySun0UtcNoon(ymd: string): number | null {
  const p = splitYmd(ymd);
  if (!p) return null;
  return new Date(Date.UTC(p.y, p.mo - 1, p.da, 12, 0, 0)).getUTCDay();
}

function nextWeekdayFromYmd(anchorYmd: string, targetWeekday: number): string | null {
  const cur = weekdaySun0UtcNoon(anchorYmd);
  if (cur === null) return null;
  let delta = (targetWeekday - cur + 7) % 7;
  if (delta === 0) delta = 7;
  return addDaysToYmd(anchorYmd, delta);
}

/** Local wall-clock parts at instant `utcMs` using ECMAScript timezone offset (minutes). */
function utcMillisToLocalWallParts(
  utcMs: number,
  tzOffsetMinutes: number,
): { y: number; mo: number; da: number; h: number; mi: number } {
  const adjustedMs = utcMs - tzOffsetMinutes * 60000;
  const d = new Date(adjustedMs);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    da: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
  };
}

function formatWestern12hFromHourMinute(h24: number, mi: number): string {
  const suffix = h24 >= 12 ? "PM" : "AM";
  let h = h24 % 12;
  if (h === 0) h = 12;
  return `${h}:${String(mi).padStart(2, "0")} ${suffix}`;
}

function shortEnglishDateFromParts(y: number, mo: number, da: number): string {
  const w = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const u = new Date(Date.UTC(y, mo - 1, da, 12, 0, 0));
  return `${w[u.getUTCDay()]}, ${months[mo - 1]} ${da}`;
}

/** D/M/Y and month-name forms; returns YYYY-MM-DD anchored to client's calendar day. */
function parseNumericDateToYmd(text: string, anchorYmd: string): string | null {
  const anchor = splitYmd(anchorYmd);
  if (!anchor) return null;
  const t = text.trim().toLowerCase();

  const m1 = t.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);
  if (m1) {
    const da = Number(m1[1]);
    const mo = Number(m1[2]);
    let y = Number(m1[3]);
    if (y < 100) y += 2000;
    const cand = fmtYmd(y, mo, da);
    return splitYmd(cand) ? cand : null;
  }

  const m2 = t.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i);
  if (m2) {
    const day = Number(m2[1]);
    const mon = [
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
      "jul",
      "aug",
      "sep",
      "oct",
      "nov",
      "dec",
    ].indexOf(m2[2].slice(0, 3).toLowerCase());
    if (mon < 0 || day < 1 || day > 31) return null;
    let y = anchor.y;
    let cand = fmtYmd(y, mon + 1, day);
    if (!splitYmd(cand)) return null;
    if (cand < anchorYmd) cand = fmtYmd(y + 1, mon + 1, day);
    return splitYmd(cand) ? cand : null;
  }

  const m3 = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/i);
  if (m3) {
    const mon = [
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
      "jul",
      "aug",
      "sep",
      "oct",
      "nov",
      "dec",
    ].indexOf(m3[1].slice(0, 3).toLowerCase());
    const day = Number(m3[2]);
    if (mon < 0 || day < 1 || day > 31) return null;
    let y = anchor.y;
    let cand = fmtYmd(y, mon + 1, day);
    if (!splitYmd(cand)) return null;
    if (cand < anchorYmd) cand = fmtYmd(y + 1, mon + 1, day);
    return splitYmd(cand) ? cand : null;
  }

  return null;
}

function resolveDueDatePhrase(phrase: string | null, anchorYmd: string): { iso: string | null; ymd: string | null } {
  if (!phrase) return { iso: null, ymd: null };
  const p = phrase.toLowerCase().trim();
  let ymd: string | null = null;

  if (p === "today") {
    ymd = anchorYmd;
  } else if (p === "tomorrow") {
    ymd = addDaysToYmd(anchorYmd, 1);
  } else if (p === "this week") {
    ymd = addDaysToYmd(anchorYmd, 3);
  } else if (p === "next week") {
    ymd = addDaysToYmd(anchorYmd, 7);
  } else {
    const dayMap: Record<string, number> = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
    };
    for (const [name, idx] of Object.entries(dayMap)) {
      if (p === `next ${name}`) {
        ymd = nextWeekdayFromYmd(anchorYmd, idx);
        break;
      }
    }
    if (!ymd) {
      ymd = parseNumericDateToYmd(p, anchorYmd);
    }
  }

  if (!ymd || !splitYmd(ymd)) return { iso: null, ymd: null };
  return { iso: utcNoonIsoFromYmd(ymd), ymd };
}

/** Short actionable title — not the full voice transcript. */
function normalizeTaskTitle(working: string, original: string): string {
  let t = working.replace(/^[\s,.;:\-/]+|[\s,.;:\-/]+$/g, "").trim();

  const prefix =
    /^(i\s+need\s+to|i\s+have\s+to|i\s+must|i\s+should|please\s+|can\s+you\s+|could\s+you\s+|remind\s+me(?:\s+at)?\s+to\s+|don't\s+forget\s+to\s+|remember\s+to\s+|task\s*:\s*|todo\s*:\s*|add\s+(?:a\s+)?task\s*:?\s*)/i;
  t = t.replace(prefix, "").trim();

  // Keep the actionable reminder intent and remove conversational filler.
  t = t.replace(/^that\s+will\s+help\s+me\s+to\s+remind(?:\s+me)?\s+to\s+/i, "task to ");
  t = t.replace(/^remind(?:\s+me)?\s+to\s+/i, "task to ");

  if (t.length > 130) {
    const cut = t.slice(0, 127).trim();
    const sp = cut.lastIndexOf(" ");
    t = (sp > 35 ? cut.slice(0, sp) : cut) + "...";
  }

  if (t.length >= 4) return t;

  const o = original.trim();
  let sentence = o.split(/(?<=[.!?])\s+/)[0]?.trim() ?? o;
  sentence = sentence.replace(prefix, "").trim();
  if (sentence.length > 130) sentence = sentence.slice(0, 127).trim() + "...";
  return sentence.length >= 3 ? sentence : "New task";
}

export function preprocessTaskInput(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:please\s+)?(?:add|create)\s+(?:a\s+)?task\s*:?\s*/i, "")
    .trim();
}

const BAD_SEMANTIC_TITLES = new Set([
  "that will help me",
  "remind me",
  "create a task",
  "add a task",
  "something important",
  "task",
  "reminder",
]);

function isUsableSemanticTitle(title: string): boolean {
  const normalized = title.replace(/\s+/g, " ").trim();
  return normalized.length >= 2 && normalized.length <= 100 && !BAD_SEMANTIC_TITLES.has(normalized.toLowerCase());
}

function mergeSemanticExtraction(
  deterministic: ParsedTaskPreview,
  semantic: SemanticTaskExtraction,
): ParsedTaskPreview {
  const category = ["Academic", "Work", "Health", "Finance", "Personal"].includes(semantic.category ?? "")
    ? semantic.category
    : deterministic.category;
  const hasDueInformation = Boolean(deterministic.dueDateIso || deterministic.dueTime);

  return {
    ...deterministic,
    title: isUsableSemanticTitle(semantic.title) ? semantic.title.trim() : deterministic.title,
    description: semantic.description,
    category,
    priority: deterministic.priorityDetected ? deterministic.priority : semantic.priority,
    confidence: Math.max(deterministic.confidence, semantic.confidence),
    // Missing temporal information remains confirmation-worthy even when the model is confident.
    needsConfirmation: deterministic.needsConfirmation || !hasDueInformation,
  };
}

function smartTitleFromIntent(rawTitle: string): string {
  const s = rawTitle.trim().toLowerCase();
  const washCar = s.match(/\b(wash|clean)\s+(my\s+)?car\b/i);
  if (washCar) return "Car wash";
  const med = s.match(/\b(take|taking)\s+(my\s+)?medicine\b/i);
  if (med) return "Medicine intake";
  return rawTitle;
}

function buildDueSummary(
  dueDateText: string | null,
  dueTime: string | null,
  iso: string | null,
): string | null {
  const parts: string[] = [];
  let dateLabel = dueDateText;
  if (!dateLabel && iso) {
    const d = new Date(iso);
    dateLabel = d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }
  if (dateLabel) parts.push(dateLabel);
  if (dueTime) parts.push(dueTime);
  return parts.length ? parts.join(" · ") : null;
}

export function parseTaskFromText(raw: string, opts?: ParseTaskOptions): ParsedTaskPreview {
  const anchorYmd = resolveAnchorYmd(opts);
  const original = raw.trim();
  let working = original.replace(/\s+/g, " ");

  let dueDateText: string | null = null;
  let dueTime: string | null = null;
  /** When set early (relative time), skips phrase-based {@link resolveDueDatePhrase}. */
  let resolvedIso: string | null = null;
  let resolvedYmd: string | null = null;
  let priority: Priority = Priority.MEDIUM;
  let category: string | null = null;
  let priorityFound = false;
  let categoryFound = false;
  let dateFound = false;
  let timeFound = false;

  const relativeHours = working.match(/\b(?:after|in)\s+(\d{1,2})\s+hours?\b/i);
  const relativeMinutes = working.match(/\b(?:after|in)\s+(\d{1,3})\s+minutes?\b/i);
  if (relativeHours || relativeMinutes) {
    const addH = relativeHours ? Number(relativeHours[1]) : 0;
    const addM = relativeMinutes ? Number(relativeMinutes[1]) : 0;
    const baseParsed =
      opts?.clientNowIso && !Number.isNaN(Date.parse(opts.clientNowIso))
        ? Date.parse(opts.clientNowIso)
        : Date.now();
    const dueMs = baseParsed + addH * 3600000 + addM * 60000;

    const off =
      typeof opts?.clientTimezoneOffsetMinutes === "number" && Number.isFinite(opts.clientTimezoneOffsetMinutes)
        ? opts.clientTimezoneOffsetMinutes
        : new Date().getTimezoneOffset();

    const lp = utcMillisToLocalWallParts(dueMs, off);
    resolvedYmd = fmtYmd(lp.y, lp.mo, lp.da);
    resolvedIso = utcNoonIsoFromYmd(resolvedYmd);
    dueDateText = shortEnglishDateFromParts(lp.y, lp.mo, lp.da);
    dueTime = formatWestern12hFromHourMinute(lp.h, lp.mi);
    working = working
      .replace(relativeHours?.[0] ?? "", " ")
      .replace(relativeMinutes?.[0] ?? "", " ")
      .replace(/\s+/g, " ")
      .trim();
    dateFound = true;
    timeFound = true;
  }

  const lower = working.toLowerCase();

  for (const phrase of DATE_PHRASES) {
    const idx = lower.indexOf(phrase);
    if (idx !== -1) {
      dueDateText = working.slice(idx, idx + phrase.length);
      working = (working.slice(0, idx) + " " + working.slice(idx + phrase.length)).replace(/\s+/g, " ").trim();
      dateFound = true;
      break;
    }
  }

  if (!dateFound) {
    const m = working.match(
      /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2})\b/i,
    );
    if (m) {
      dueDateText = m[1];
      working = working.replace(m[0], " ").replace(/\s+/g, " ").trim();
      dateFound = true;
    }
  }

  for (const { re, label } of TIME_PATTERNS) {
    const m = working.match(re);
    if (m) {
      dueTime = label(m);
      working = working.replace(m[0], " ").replace(/\s+/g, " ").trim();
      timeFound = true;
      break;
    }
  }

  for (const rule of PRIORITY_RULES) {
    const m = working.match(rule.words);
    if (m) {
      priority = rule.value;
      priorityFound = true;
      working = working.replace(m[0], " ").replace(/\s+/g, " ").trim();
      break;
    }
  }

  for (const rule of CATEGORY_RULES) {
    const m = working.match(rule.words);
    if (m) {
      category = rule.label;
      categoryFound = true;
      working = working.replace(m[0], " ").replace(/\s+/g, " ").trim();
      break;
    }
  }

  const title = smartTitleFromIntent(normalizeTaskTitle(working, original));

  let confidence = 40;
  if (title.length >= 12) confidence += 15;
  else if (title.length >= 6) confidence += 10;
  if (dateFound) confidence += 18;
  if (timeFound) confidence += 14;
  if (priorityFound) confidence += 8;
  if (categoryFound) confidence += 8;
  confidence = Math.min(100, confidence);

  const needsConfirmation = confidence < 74;

  const fromPhrase = resolvedIso && resolvedYmd ? { iso: resolvedIso, ymd: resolvedYmd } : resolveDueDatePhrase(dueDateText, anchorYmd);
  const dueSummary = buildDueSummary(dueDateText, dueTime, fromPhrase.iso);

  return {
    title,
    description: null,
    dueDateText,
    dueTime,
    dueSummary,
    priority,
    category,
    confidence,
    needsConfirmation,
    priorityDetected: priorityFound,
    timeDetected: timeFound,
    dueDateIso: fromPhrase.iso,
    dueDateYmd: fromPhrase.ymd,
  };
}

export async function parseTaskFromTextHybrid(
  raw: string,
  opts?: ParseTaskOptions,
  aiService = new AiService(),
): Promise<ParsedTaskPreview> {
  const deterministic = parseTaskFromText(raw, opts);
  const semantic = await aiService.extractTask(preprocessTaskInput(raw));
  return semantic ? mergeSemanticExtraction(deterministic, semantic) : deterministic;
}
