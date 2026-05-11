/** Collapse exotic spaces / dotted a.m./p.m. so parser + JS Date fallback agree. */
export function normalizeDueTimeString(raw: string): string {
  let s = raw
    .trim()
    .replace(/[\u202F\u00A0\u2007]/g, " ")
    .replace(/\s+/g, " ");
  s = s.replace(/\s*:\s*/g, ":");
  s = s.replace(/(\d)(am|pm)\b/gi, "$1 $2");
  s = s.replace(/\bp\.?\s*m\.?\b/gi, "PM");
  s = s.replace(/\ba\.?\s*m\.?\b/gi, "AM");
  return s.trim();
}

/** Parse "5:30 PM", "14:30", morning/afternoon/evening/night — same rules as local reminders. */
export function parseDueTimeToHoursMinutes(raw: string): { h: number; m: number } | null {
  const t = normalizeDueTimeString(raw);
  if (!t) return null;

  const wordTime = t.toLowerCase();
  if (wordTime === "morning") return { h: 9, m: 0 };
  if (wordTime === "afternoon") return { h: 15, m: 0 };
  if (wordTime === "evening") return { h: 18, m: 0 };
  if (wordTime === "night") return { h: 21, m: 0 };

  const h24 = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/i);
  if (h24) {
    const h = Number(h24[1]);
    const m = Number(h24[2]);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return { h, m };
  }

  const hh12 = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (hh12) {
    let h = Number(hh12[1]);
    const m = Number(hh12[2] ?? "0");
    const ampm = hh12[3].toUpperCase();
    if (h < 1 || h > 12 || m < 0 || m > 59) return null;
    if (ampm === "PM" && h < 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
    return { h, m };
  }

  return null;
}

/** Parse time into local hours/minutes using regex first, then `Date` fallback for locale strings from the parser. */
export function resolveDueTimeHm(dueTime: string | null | undefined, refCalendarDay: Date): { h: number; m: number } | null {
  if (!dueTime?.trim()) return null;
  const numeric = parseDueTimeToHoursMinutes(dueTime);
  if (numeric) return numeric;
  const norm = normalizeDueTimeString(dueTime);
  if (!norm) return null;
  const y = refCalendarDay.getFullYear();
  const mo = refCalendarDay.getMonth();
  const d = refCalendarDay.getDate();
  const mm = String(mo + 1).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  const candidate = new Date(`${y}-${mm}-${dd} ${norm}`);
  if (Number.isNaN(candidate.getTime())) return null;
  return { h: candidate.getHours(), m: candidate.getMinutes() };
}

export function ymdFromLocalDate(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

export function localMidnightIsoFromYmd(ymd: string): string | null {
  const m = ymd.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  const d = new Date(y, mo - 1, da, 0, 0, 0, 0);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(`${ymd.trim()}T00:00:00`).toISOString();
}

/**
 * Re-encode any due-date instant like the manual Add Task form does:
 * read the device's calendar day → local midnight → `.toISOString()`.
 * Parser/backend ISO strings often use server "today/tomorrow"; this aligns reminders with picker tasks.
 */
export function manualPickerMidnightIsoFromDueDateIso(isoRaw: string): string | null {
  const trimmed = isoRaw.trim();
  if (!trimmed) return null;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return localMidnightIsoFromYmd(ymdFromLocalDate(d));
}

/** When backend/parser returns due time without a calendar day — use today, or tomorrow if that time already passed. */
export function effectiveDueDateIso(
  dueDateIso: string | null | undefined,
  dueTime: string | null | undefined,
  now = new Date(),
): string | null {
  const dIn = dueDateIso?.trim() ? String(dueDateIso) : "";
  if (dIn) {
    return manualPickerMidnightIsoFromDueDateIso(dIn) ?? dIn;
  }

  const hm = resolveDueTimeHm(dueTime, now);
  if (!hm) return null;

  const y = now.getFullYear();
  const mo = now.getMonth();
  const da = now.getDate();
  let candidate = new Date(y, mo, da, hm.h, hm.m, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate = new Date(y, mo, da + 1, hm.h, hm.m, 0, 0);
  }
  const ymd = ymdFromLocalDate(candidate);
  return localMidnightIsoFromYmd(ymd);
}

/**
 * Same due encoding as manual Add / Edit Task (and reminders): optional `YYYY-MM-DD` from pickers,
 * else derive local calendar day from parser/backend ISO → `${ymd}T00:00:00` → ISO, then
 * {@link effectiveDueDateIso}.
 */
export function dueDateAndTimeForSave(opts: {
  pickerYmd?: string | null;
  parsedDueDateIso?: string | null;
  rawDueTime?: string | null;
}): { dueDateIso: string | null; dueTime: string | null } {
  const dueTime = (opts.rawDueTime ?? "").trim() || null;

  const ymdFromPicker = (opts.pickerYmd ?? "").trim();
  let pickedIso: string | null = null;
  if (ymdFromPicker.length > 0) {
    pickedIso = new Date(`${ymdFromPicker}T00:00:00`).toISOString();
  } else {
    const trimmedParser = (opts.parsedDueDateIso ?? "").trim();
    if (trimmedParser) {
      const ymd = ymdFromLocalDate(new Date(trimmedParser));
      pickedIso = new Date(`${ymd}T00:00:00`).toISOString();
    }
  }

  const dueDateIso = effectiveDueDateIso(pickedIso, dueTime);
  return { dueDateIso, dueTime };
}

export function formatDueTime12h(d: Date): string {
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function combineYmdAndTimeStrings(ymd: string | undefined, timeStr: string | undefined): Date {
  const ymdUse = ymd?.trim() || ymdFromLocalDate(new Date());
  const [yy, mo, da] = ymdUse.split("-").map((n) => Number(n));
  const base = new Date(yy, mo - 1, da, 0, 0, 0, 0);
  const hm = resolveDueTimeHm(timeStr, base);
  if (hm) base.setHours(hm.h, hm.m, 0, 0);
  return base;
}

/** Fire time for a local notification (same calendar semantics as previous parseTaskReminderDate). */
export function computeReminderTriggerAt(dueDateIso: string | null, dueTime: string | null): Date | null {
  if (!dueDateIso?.trim()) return null;
  const normalized =
    manualPickerMidnightIsoFromDueDateIso(String(dueDateIso).trim()) ?? dueDateIso.trim();
  const dueBase = new Date(normalized);
  if (Number.isNaN(dueBase.getTime())) return null;

  const year = dueBase.getFullYear();
  const month = dueBase.getMonth();
  const day = dueBase.getDate();

  let hours = 9;
  let minutes = 0;

  if (dueTime?.trim()) {
    const hm = resolveDueTimeHm(dueTime, dueBase);
    if (hm) {
      hours = hm.h;
      minutes = hm.m;
    }
  }

  return new Date(year, month, day, hours, minutes, 0, 0);
}

export function dueDateTimeToDate(dueDateIso: string | null, dueTime: string | null): Date | null {
  if (!dueDateIso?.trim()) return null;
  const normalized =
    manualPickerMidnightIsoFromDueDateIso(String(dueDateIso).trim()) ?? dueDateIso.trim();
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;

  if (!dueTime?.trim()) {
    date.setHours(9, 0, 0, 0);
    return date;
  }

  const hm = resolveDueTimeHm(dueTime, date);
  if (hm) {
    date.setHours(hm.h, hm.m, 0, 0);
    return date;
  }

  date.setHours(9, 0, 0, 0);
  return date;
}

export function validateDueDateNotPast(dueDateIso: string | null, dueTime: string | null): string | null {
  const due = dueDateTimeToDate(dueDateIso, dueTime);
  if (!due) return null;
  if (due.getTime() < Date.now()) {
    return "Due date/time cannot be in the past.";
  }
  return null;
}
