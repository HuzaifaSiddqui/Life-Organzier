import { createHash } from "node:crypto";
import { computeEstimateRatios, ratiosByCompletion, taskRatio, type RatioTask } from "../patterns/estimateRatio.js";

/**
 * FR-RN-004 evaluation: pure aggregation over exported rows (no DB), used by scripts/checkin-report.ts.
 * Stale answers (given after the check-in was cancelled) are excluded from every outcome measure.
 */

export const START_WINDOW_MIN = 15;
export const MIN_CELL_N = 20;

export type CheckinRow = {
  user: string;
  kind: string;
  tone: string;
  hasFirstStep: boolean;
  copySource: string;
  researchMode: boolean;
  status: string;
  response: string | null;
  stale: boolean;
  fireAt: Date;
  respondedAt: Date | null;
};

/** `day`: the user's local date of the event, used to count one display per day. */
export type SuggestionRow = { user: string; action: "SHOWN" | "ACCEPTED"; surface: string; category: string; original: number; suggested: number; at: Date; day: string };
export type EvalTask = RatioTask & { user: string; createdAt: Date };

/** Pseudonymous id: salted so the export can't be matched against known user ids. */
export const pseudonym = (id: string, salt: string): string => createHash("sha256").update(`${salt}:${id}`).digest("hex").slice(0, 10);

export type Cell = {
  n: number;
  k: number;
  rate: number | null;
  lo: number | null;
  hi: number | null;
  tooFew: boolean;
  /** Distinct users contributing, and the mean of each user's own rate (every user weighted equally). */
  users: number;
  perUserRate: number | null;
};

/** 95% Wilson score interval for k successes in n trials (assumes independent trials). */
export function wilson(k: number, n: number): { lo: number; hi: number } | null {
  if (n === 0) return null;
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d) };
}

export type Trial = { user: string; ok: boolean };

export function cell(trials: Trial[]): Cell {
  const n = trials.length;
  const k = trials.filter((t) => t.ok).length;
  const w = wilson(k, n);
  const per = new Map<string, { k: number; n: number }>();
  for (const t of trials) {
    const e = per.get(t.user) ?? { k: 0, n: 0 };
    e.n += 1;
    if (t.ok) e.k += 1;
    per.set(t.user, e);
  }
  const rates = [...per.values()].map((e) => e.k / e.n);
  return { n, k, rate: n ? k / n : null, lo: w?.lo ?? null, hi: w?.hi ?? null, tooFew: n < MIN_CELL_N, users: per.size, perUserRate: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null };
}

/** (a) Per kind: answered / ignored / stale among check-ins that were resolved (answered or ignored). */
export function responseRatesByKind(rows: CheckinRow[]) {
  const out = new Map<string, { answered: number; ignored: number; stale: number }>();
  for (const r of rows) {
    if (r.status !== "ANSWERED" && r.status !== "IGNORED") continue;
    const e = out.get(r.kind) ?? { answered: 0, ignored: 0, stale: 0 };
    if (r.status === "IGNORED") e.ignored += 1;
    else if (r.stale) e.stale += 1;
    else e.answered += 1;
    out.set(r.kind, e);
  }
  return [...out.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([kind, e]) => ({ kind, ...e, total: e.answered + e.ignored + e.stale }));
}

/** First-step group: where the shown step came from; WITHHELD = research control, NONE = no step. */
export const firstStepGroup = (r: CheckinRow): string => r.copySource;

/** (b) Start rate: % of resolved, non-stale START check-ins answered STARTED within 15 min of fireAt (tap time). */
export function startRate(rows: CheckinRow[], by: (r: CheckinRow) => string): Array<{ group: string } & Cell> {
  const groups = new Map<string, Trial[]>();
  for (const r of rows) {
    if (r.kind !== "START" || r.stale || (r.status !== "ANSWERED" && r.status !== "IGNORED")) continue;
    const ok = r.response === "STARTED" && r.respondedAt !== null && r.respondedAt.getTime() - r.fireAt.getTime() <= START_WINDOW_MIN * 60000;
    groups.set(by(r), [...(groups.get(by(r)) ?? []), { user: r.user, ok }]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, t]) => ({ group, ...cell(t) }));
}

/**
 * Research comparison: only rows planned while research mode was on (where showing the step was
 * randomised 50/50), START check-ins with a shown first step (any source) vs WITHHELD.
 */
export function researchComparison(rows: CheckinRow[]) {
  const inStudy = rows.filter((r) => r.researchMode && (r.hasFirstStep || r.copySource === "WITHHELD"));
  return startRate(inStudy, (r) => (r.copySource === "WITHHELD" ? "WITHHELD (control)" : "SHOWN"));
}

/**
 * (c) Suggestion acceptance. One display counts once per user + category + original minutes + local day,
 * and counts as accepted if the same key has an ACCEPTED event.
 */
export function acceptance(rows: SuggestionRow[]) {
  const key = (r: SuggestionRow) => `${r.user}|${r.category}|${r.original}|${r.day}`;
  const accepted = new Set(rows.filter((r) => r.action === "ACCEPTED").map(key));
  const shown = new Map<string, Trial & { category: string }>();
  for (const r of rows) if (r.action === "SHOWN" && !shown.has(key(r))) shown.set(key(r), { user: r.user, ok: accepted.has(key(r)), category: r.category });
  const by = new Map<string, Trial[]>();
  for (const t of shown.values()) for (const g of ["ALL", t.category]) by.set(g, [...(by.get(g) ?? []), t]);
  return [...by.entries()].sort(([a], [b]) => (a === "ALL" ? -1 : b === "ALL" ? 1 : a.localeCompare(b))).map(([category, t]) => ({ category, shown: t.length, accepted: t.filter((x) => x.ok).length, ...cell(t) }));
}

export const ratiosByCategory = computeEstimateRatios;

const meanOf = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * (d) Descriptive only. Mean |actual − planned| ÷ planned, restricted to the categories in which the user
 * was shown a suggestion, split at the user's first display in that category; after the first display,
 * tasks are further split by whether the user had accepted a suggestion in that category by then.
 */
export function accuracyDescriptive(tasks: EvalTask[], suggestions: SuggestionRow[]) {
  const firstShown = new Map<string, number>();
  const firstAccepted = new Map<string, number>();
  for (const s of suggestions) {
    const k = `${s.user}|${s.category}`;
    const m = s.action === "SHOWN" ? firstShown : firstAccepted;
    m.set(k, Math.min(m.get(k) ?? Infinity, s.at.getTime()));
  }
  const g = { before: [] as number[], after: [] as number[], acceptedBy: [] as number[], notAccepted: [] as number[] };
  for (const t of tasks) {
    const k = `${t.user}|${t.category ?? "Uncategorized"}`;
    const f = firstShown.get(k);
    const r = taskRatio(t);
    if (f === undefined || r === null) continue;
    const err = Math.abs(r - 1);
    if (t.createdAt.getTime() < f) {
      g.before.push(err);
      continue;
    }
    g.after.push(err);
    ((firstAccepted.get(k) ?? Infinity) <= t.createdAt.getTime() ? g.acceptedBy : g.notAccepted).push(err);
  }
  const part = (xs: number[]) => ({ n: xs.length, mean: meanOf(xs) });
  return { before: part(g.before), after: part(g.after), acceptedBefore: part(g.acceptedBy), shownNotAccepted: part(g.notAccepted) };
}

/* ------------------------------------------------------------------------------ output */

const csvCell = (v: unknown) => {
  const s = v instanceof Date ? v.toISOString() : String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (header: string[], rows: unknown[][]) => [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

export function checkinCsv(rows: CheckinRow[]): string {
  return toCsv(
    ["user", "kind", "tone", "hasFirstStep", "copySource", "researchMode", "status", "response", "stale", "fireAt", "respondedAt", "minutesToRespond"],
    rows.map((r) => [r.user, r.kind, r.tone, r.hasFirstStep, r.copySource, r.researchMode, r.status, r.response, r.stale, r.fireAt, r.respondedAt, r.respondedAt ? Math.round((r.respondedAt.getTime() - r.fireAt.getTime()) / 60000) : ""]),
  );
}

export function suggestionCsv(rows: SuggestionRow[]): string {
  return toCsv(["user", "action", "surface", "category", "originalMinutes", "suggestedMinutes", "at"], rows.map((r) => [r.user, r.action, r.surface, r.category, r.original, r.suggested, r.at]));
}

const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);
const cellText = (c: Cell) =>
  c.n === 0 ? "n=0" : `${pct(c.rate)} (${c.k}/${c.n}, 95% CI ${pct(c.lo)}–${pct(c.hi)}) · ${c.users} user${c.users === 1 ? "" : "s"} · per-user avg ${pct(c.perUserRate)}${c.tooFew ? " — too few to compare" : ""}`;

export function renderReport(input: { checkins: CheckinRow[]; suggestions: SuggestionRow[]; tasks: EvalTask[]; from?: string; to?: string; generatedAt: Date; excludedUsers: number }): string {
  const { checkins, suggestions, tasks } = input;
  const L: string[] = [];
  L.push("# Check-in evaluation results", "");
  L.push(`Generated ${input.generatedAt.toISOString()} · range ${input.from ?? "start"} → ${input.to ?? "now"} · ${input.excludedUsers} user(s) excluded · method: \`docs/checkins-evaluation-method.md\``, "");
  L.push("> **Reading the intervals.** 95% Wilson intervals assume independent check-ins. Check-ins cluster by user, so the intervals are approximate (too narrow); the per-user average, which weights every user equally, is the safer headline when few users contribute.", "");
  L.push("## (a) Response rates by kind", "", "| Kind | Answered | Ignored | Stale | Total | Answered % |", "|---|---|---|---|---|---|");
  for (const r of responseRatesByKind(checkins)) L.push(`| ${r.kind} | ${r.answered} | ${r.ignored} | ${r.stale} | ${r.total} | ${pct(r.total ? r.answered / r.total : null)} |`);
  L.push("", `## (b) Start rate (START answered "Started" within ${START_WINDOW_MIN} min of fire time)`, "", "Stale answers are excluded. Cells with n < 20 are not comparable.", "");
  L.push("### Research comparison (randomised)", "", "Only check-ins planned while research mode was on, where the first step was shown or withheld 50/50. This is the only table here that supports a causal reading.", "", "| Group | Start rate |", "|---|---|");
  for (const g of researchComparison(checkins)) L.push(`| ${g.group} | ${cellText(g)} |`);
  L.push("");
  for (const [title, by] of [["By tone (descriptive, not randomised)", (r: CheckinRow) => r.tone], ["By first-step source (descriptive, not randomised; WITHHELD = research control, NONE = no step available)", firstStepGroup]] as const) {
    L.push(`### ${title}`, "", "| Group | Start rate |", "|---|---|");
    for (const g of startRate(checkins, by)) L.push(`| ${g.group} | ${cellText(g)} |`);
    L.push("");
  }
  L.push("## (c) Estimate ratio and suggestions", "", "Median actual ÷ estimated duration per category (all users pooled, ≥ 5 usable tasks; same-day work only), by how the task was completed:", "");
  const ratios = ratiosByCompletion(tasks);
  L.push(ratios.length ? "| Category | Completed via | Ratio | Tasks |\n|---|---|---|---|" : "No category has 5 usable tasks yet.");
  for (const r of ratios) L.push(`| ${r.category} | ${r.via === "CHECKIN" ? "check-in answer" : "manual"} | ${r.ratio}× | ${r.n} |`);
  L.push("", "Suggestion acceptance (accepted ÷ shown; one display counted per user, category, original duration and day):", "", "| Category | Shown | Accepted | Acceptance |", "|---|---|---|---|");
  for (const a of acceptance(suggestions)) L.push(`| ${a.category === "ALL" ? "All" : a.category} | ${a.shown} | ${a.accepted} | ${cellText(a)} |`);
  const acc = accuracyDescriptive(tasks, suggestions);
  const m = (x: { n: number; mean: number | null }) => `${x.mean === null ? "–" : x.mean.toFixed(2)} (n=${x.n}${x.n < MIN_CELL_N ? ", too few to compare" : ""})`;
  L.push("", "## (d) Estimate accuracy — descriptive (not causal: practice and novelty effects)", "", "Mean |actual − planned| ÷ planned, only for categories in which that user was shown a suggestion, split at the user's first display in that category:", "", `- Created before the first suggestion: ${m(acc.before)}`, `- Created after it: ${m(acc.after)}`, `  - user had already accepted a suggestion in that category: ${m(acc.acceptedBefore)}`, `  - shown but not accepted: ${m(acc.shownNotAccepted)}`, "");
  return L.join("\n");
}
