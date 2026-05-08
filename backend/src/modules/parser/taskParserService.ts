import { Priority } from "@prisma/client";

export type ParsedTaskPreview = {
  title: string;
  dueDateText: string | null;
  dueTime: string | null;
  priority: Priority;
  category: string | null;
  confidence: number;
  needsConfirmation: boolean;
  dueDateIso: string | null;
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
  { re: /\b(\d{1,2}):(\d{2})\s*(am|pm)\b/i, label: (m) => `${m[1]}:${m[2]} ${m[3].toUpperCase()}` },
  { re: /\b(\d{1,2})\s*(am|pm)\b/i, label: (m) => `${m[1]} ${m[2].toUpperCase()}` },
  { re: /\b(\d{1,2}):(\d{2})\b/, label: (m) => `${m[1]}:${m[2]}` },
  { re: /\b(morning|afternoon|evening|night)\b/i, label: (m) => m[1].toLowerCase() },
];

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function nextWeekday(from: Date, targetWeekday: number): Date {
  const d = startOfDay(from);
  const current = d.getDay();
  let delta = (targetWeekday - current + 7) % 7;
  if (delta === 0) delta = 7;
  return addDays(d, delta);
}

function parseNumericDate(text: string, now: Date): Date | null {
  const t = text.trim();
  const m1 = t.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);
  if (m1) {
    const day = Number(m1[1]);
    const month = Number(m1[2]) - 1;
    let year = Number(m1[3]);
    if (year < 100) year += 2000;
    const d = new Date(year, month, day);
    return Number.isNaN(d.getTime()) ? null : startOfDay(d);
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
    if (mon < 0) return null;
    let year = now.getFullYear();
    const cand = new Date(year, mon, day);
    if (cand < startOfDay(now)) year += 1;
    return startOfDay(new Date(year, mon, day));
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
    if (mon < 0) return null;
    let year = now.getFullYear();
    const cand = new Date(year, mon, day);
    if (cand < startOfDay(now)) year += 1;
    return startOfDay(new Date(year, mon, day));
  }
  return null;
}

function resolveDueDate(phrase: string | null, now: Date): { iso: string | null; text: string | null } {
  if (!phrase) return { iso: null, text: null };
  const p = phrase.toLowerCase().trim();
  const today = startOfDay(now);

  if (p === "today") {
    return { iso: today.toISOString(), text: phrase };
  }
  if (p === "tomorrow") {
    return { iso: addDays(today, 1).toISOString(), text: phrase };
  }
  if (p === "this week") {
    return { iso: addDays(today, 3).toISOString(), text: phrase };
  }
  if (p === "next week") {
    return { iso: addDays(today, 7).toISOString(), text: phrase };
  }

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
      return { iso: nextWeekday(now, idx).toISOString(), text: phrase };
    }
  }

  const numeric = parseNumericDate(p, now);
  if (numeric) {
    return { iso: numeric.toISOString(), text: phrase };
  }

  return { iso: null, text: phrase };
}

export function parseTaskFromText(raw: string, referenceDate = new Date()): ParsedTaskPreview {
  const original = raw.trim();
  let working = original.replace(/\s+/g, " ");

  let dueDateText: string | null = null;
  let dueTime: string | null = null;
  let priority: Priority = Priority.MEDIUM;
  let category: string | null = null;
  let priorityFound = false;
  let categoryFound = false;
  let dateFound = false;
  let timeFound = false;

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
      /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2})\b/i
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

  let title = working.replace(/^[\s,.:-]+|[\s,.:-]+$/g, "").trim();
  if (!title) {
    title = original;
  }

  let confidence = 0;
  if (title.length > 0) confidence += 30;
  if (dateFound) confidence += 25;
  if (timeFound) confidence += 15;
  if (priorityFound) confidence += 15;
  if (categoryFound) confidence += 15;

  const { iso } = resolveDueDate(dueDateText, referenceDate);

  const needsConfirmation = confidence < 80;

  return {
    title,
    dueDateText,
    dueTime,
    priority,
    category,
    confidence,
    needsConfirmation,
    dueDateIso: iso,
  };
}
