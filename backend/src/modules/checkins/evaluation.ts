import { computeEstimateRatios, taskRatio, type RatioTask } from "../patterns/estimateRatio.js";

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
  status: string;
  response: string | null;
  stale: boolean;
  fireAt: Date;
  respondedAt: Date | null;
};

export type SuggestionRow = { user: string; action: "SHOWN" | "ACCEPTED"; surface: string; category: string; original: number; suggested: number; at: Date };
export type EvalTask = RatioTask & { user: string; createdAt: Date };

export type Cell = { n: number; k: number; rate: number | null; lo: number | null; hi: number | null; tooFew: boolean };

/** 95% Wilson score interval for k successes in n trials. */
export function wilson(k: number, n: number): { lo: number; hi: number } | null {
  if (n === 0) return null;
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d) };
}

export function cell(k: number, n: number): Cell {
  const w = wilson(k, n);
  return { n, k, rate: n ? k / n : null, lo: w?.lo ?? null, hi: w?.hi ?? null, tooFew: n < MIN_CELL_N };
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
  const groups = new Map<string, { k: number; n: number }>();
  for (const r of rows) {
    if (r.kind !== "START" || r.stale || (r.status !== "ANSWERED" && r.status !== "IGNORED")) continue;
    const g = groups.get(by(r)) ?? { k: 0, n: 0 };
    g.n += 1;
    if (r.response === "STARTED" && r.respondedAt && r.respondedAt.getTime() - r.fireAt.getTime() <= START_WINDOW_MIN * 60000) g.k += 1;
    groups.set(by(r), g);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, g]) => ({ group, ...cell(g.k, g.n) }));
}

/** (c) Suggestion acceptance: ACCEPTED ÷ SHOWN, overall and per category. */
export function acceptance(rows: SuggestionRow[]) {
  const by = new Map<string, { shown: number; accepted: number }>();
  for (const r of rows) {
    for (const key of ["ALL", r.category]) {
      const e = by.get(key) ?? { shown: 0, accepted: 0 };
      if (r.action === "SHOWN") e.shown += 1;
      else e.accepted += 1;
      by.set(key, e);
    }
  }
  return [...by.entries()].sort(([a], [b]) => (a === "ALL" ? -1 : b === "ALL" ? 1 : a.localeCompare(b))).map(([category, e]) => ({ category, ...e, ...cell(e.accepted, e.shown) }));
}

export const ratiosByCategory = computeEstimateRatios;

/**
 * (d) Mean |actual − planned| ÷ planned for tasks created after vs before the user first saw a suggestion.
 * Only users who saw at least one suggestion are compared with themselves; tasks follow the ratio rules.
 */
export function accuracyBeforeAfter(tasks: EvalTask[], suggestions: SuggestionRow[]) {
  const first = new Map<string, number>();
  for (const s of suggestions) if (s.action === "SHOWN") first.set(s.user, Math.min(first.get(s.user) ?? Infinity, s.at.getTime()));
  const before: number[] = [];
  const after: number[] = [];
  for (const t of tasks) {
    const f = first.get(t.user);
    const r = taskRatio(t);
    if (f === undefined || r === null) continue;
    (t.createdAt.getTime() >= f ? after : before).push(Math.abs(r - 1));
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return { before: { n: before.length, mean: mean(before) }, after: { n: after.length, mean: mean(after) } };
}

/* ------------------------------------------------------------------------------ output */

const csvCell = (v: unknown) => {
  const s = v instanceof Date ? v.toISOString() : String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (header: string[], rows: unknown[][]) => [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

export function checkinCsv(rows: CheckinRow[]): string {
  return toCsv(
    ["user", "kind", "tone", "hasFirstStep", "copySource", "status", "response", "stale", "fireAt", "respondedAt", "minutesToRespond"],
    rows.map((r) => [r.user, r.kind, r.tone, r.hasFirstStep, r.copySource, r.status, r.response, r.stale, r.fireAt, r.respondedAt, r.respondedAt ? Math.round((r.respondedAt.getTime() - r.fireAt.getTime()) / 60000) : ""]),
  );
}

export function suggestionCsv(rows: SuggestionRow[]): string {
  return toCsv(["user", "action", "surface", "category", "originalMinutes", "suggestedMinutes", "at"], rows.map((r) => [r.user, r.action, r.surface, r.category, r.original, r.suggested, r.at]));
}

const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);
const cellText = (c: Cell) => (c.n === 0 ? "n=0" : `${pct(c.rate)} (${c.k}/${c.n}, 95% CI ${pct(c.lo)}–${pct(c.hi)})${c.tooFew ? " — too few to compare" : ""}`);

export function renderReport(input: { checkins: CheckinRow[]; suggestions: SuggestionRow[]; tasks: EvalTask[]; from?: string; to?: string; generatedAt: Date; excludedUsers: number }): string {
  const { checkins, suggestions, tasks } = input;
  const L: string[] = [];
  L.push("# Check-in evaluation results", "");
  L.push(`Generated ${input.generatedAt.toISOString()} · range ${input.from ?? "start"} → ${input.to ?? "now"} · ${input.excludedUsers} user(s) excluded · method: \`docs/checkins-evaluation-method.md\``, "");
  L.push("## (a) Response rates by kind", "", "| Kind | Answered | Ignored | Stale | Total | Answered % |", "|---|---|---|---|---|---|");
  for (const r of responseRatesByKind(checkins)) L.push(`| ${r.kind} | ${r.answered} | ${r.ignored} | ${r.stale} | ${r.total} | ${pct(r.total ? r.answered / r.total : null)} |`);
  L.push("", `## (b) Start rate (START answered "Started" within ${START_WINDOW_MIN} min of fire time)`, "", "Stale answers are excluded. Cells with n < 20 are not comparable.", "");
  for (const [title, by] of [["By tone", (r: CheckinRow) => r.tone], ["By first-step group (GEMINI / OLLAMA / LIBRARY = shown; WITHHELD = research control; NONE = no step available)", firstStepGroup]] as const) {
    L.push(`**${title}**`, "", "| Group | Start rate |", "|---|---|");
    for (const g of startRate(checkins, by)) L.push(`| ${g.group} | ${cellText(g)} |`);
    L.push("");
  }
  L.push("## (c) Estimate ratio and suggestions", "", "Median actual ÷ estimated duration per category (all users pooled, ≥ 5 usable tasks):", "");
  const ratios = ratiosByCategory(tasks);
  L.push(ratios.length ? "| Category | Ratio | Tasks |\n|---|---|---|" : "No category has 5 usable tasks yet.");
  for (const r of ratios) L.push(`| ${r.category} | ${r.ratio}× | ${r.n} |`);
  L.push("", "Suggestion acceptance (accepted ÷ shown):", "", "| Category | Shown | Accepted | Acceptance |", "|---|---|---|---|");
  for (const a of acceptance(suggestions)) L.push(`| ${a.category === "ALL" ? "All" : a.category} | ${a.shown} | ${a.accepted} | ${a.shown ? cellText(a) : "n=0"} |`);
  const acc = accuracyBeforeAfter(tasks, suggestions);
  const m = (x: { n: number; mean: number | null }) => `${x.mean === null ? "–" : x.mean.toFixed(2)} (n=${x.n}${x.n < MIN_CELL_N ? ", too few to compare" : ""})`;
  L.push("", "## (d) Estimate accuracy", "", "Mean |actual − planned| ÷ planned, for users who saw a suggestion, by task creation time:", "", `- Before the first suggestion: ${m(acc.before)}`, `- After the first suggestion: ${m(acc.after)}`, "");
  return L.join("\n");
}
