import { addDaysYmd, weekdayOfYmd } from "../../lib/time.js";
import type { ParseCtx } from "./commands/types.js";
import { extractEntities } from "./entities.js";

/** Spans with no fixed days here (holidays, "long weekend", "end of the month"): always asked about. */
export const UNREADABLE_SPAN = /\b(?:long weekend|end of (?:the )?(?:month|week|year)|holidays?|vacation|break)\b/i;

/** "the next 3 days", "coming two days": from today on (CHAT_FIXES_V2). */
export const NEXT_N_DAYS = /\b(?:next|coming|following)\s+(\d{1,2}|two|three|four|five|six|seven|ten|fourteen)\s+days\b/i;
const WORD_NUM: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14 };

/** Days asked about, inclusive (CHAT_FIXES_V2). */
export type DayRange = { from: string; to: string; label: string };

/** A word that asks about a span of time; when none of the rules below reads it, the user is asked which days. */
export const RANGE_WORD = /\b(?:week|weekend|month|soon|later|upcoming|coming|next few|few days|before|after|until|till|between|from|by)\b/i;

/**
 * The days a question asks about: next week, this/next weekend, after the weekend, this/next month, by / until /
 * before a day, or one day (weekday names, "the 12th", dates, today / tomorrow). "unknown" = it names a span this
 * can't read (ask, never answer with today); null = no time in the question.
 */
export function resolveRange(text: string, ctx: ParseCtx): DayRange | "unknown" | null {
  const t = text.toLowerCase();
  // A span this can't read (holidays, "long weekend", "end of the month"): ask, never guess.
  if (UNREADABLE_SPAN.test(t)) return "unknown";
  const today = ctx.todayYmd;
  const dow = weekdayOfYmd(today); // 0 = Sunday
  const plus = (n: number) => addDaysYmd(today, n);
  const thisSat = dow === 0 ? plus(-1) : plus(6 - dow);
  const nextMon = plus(dow === 0 ? 1 : 8 - dow);
  const n = NEXT_N_DAYS.exec(t);
  if (n) {
    const days = Number(n[1]) || WORD_NUM[n[1]] || 0;
    if (days >= 1 && days <= 60) return { from: today, to: plus(days), label: `Next ${days} days` };
  }
  if (/\bnext week\b/.test(t)) return { from: nextMon, to: addDaysYmd(nextMon, 6), label: "Next week" };
  if (/\bnext weekend\b/.test(t)) return { from: addDaysYmd(thisSat, 7), to: addDaysYmd(thisSat, 8), label: "Next weekend" };
  if (/\bafter the weekend\b|\bafter weekend\b/.test(t)) return { from: nextMon, to: addDaysYmd(nextMon, 6), label: "After the weekend" };
  if (/\b(?:this |the )?weekend\b/.test(t)) return { from: dow === 0 ? today : thisSat, to: dow === 0 ? today : addDaysYmd(thisSat, 1), label: "This weekend" };
  // This week = Monday to Sunday (PR B); "the next 7 days" is read above as a rolling span.
  if (/\b(?:this week|is hafte|is haftay)\b/.test(t)) return { from: plus(dow === 0 ? -6 : 1 - dow), to: plus(dow === 0 ? 0 : 7 - dow), label: "This week" };
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

