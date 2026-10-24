/**
 * Rules-only evaluation of chat commands (AI off): `npm run eval:assistant` (add `--baseline` for the
 * rules as they were before the command registry). Scores tests/eval/assistant-eval.json (the intent rows
 * and the command rows) and, separately, the teammate-written tests/eval/chat-holdout.json.
 * A row is correct when the command matches (or is in `alsoOk`) and every expected argument matches.
 */
process.env.AI_ENABLED = "false";
process.env.GEMINI_API_KEY = "";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Row = { id: string; lang?: string; text: string; command: string; args?: Record<string, unknown>; alsoOk?: string[]; example?: boolean };
type EvalFile = { now: string; timezone: string; messages?: Array<{ id: string; lang: string; text: string; intent: string; alsoOk?: string[] }>; commands?: Row[] };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baseline = process.argv.includes("--baseline");
const { classify, parseCtx } = await import("../src/modules/assistant/commands/registry.js");
const { isPlausibleAnswer } = await import("../src/modules/assistant/commands/pendingAnswer.js");

const norm = (v: unknown): unknown =>
  typeof v === "string" ? v.trim().toLowerCase().replace(/\s+/g, " ") : Array.isArray(v) ? v.map(norm) : v;

function argsMatch(expected: Record<string, unknown> | undefined, got: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(expected ?? {})) {
    if (JSON.stringify(norm(got[key])) !== JSON.stringify(norm(value))) return `${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(got[key] ?? null)}`;
  }
  return null;
}

type PendingSet = { kinds: Array<Record<string, unknown> & { kind: string }>; answers: string[]; notAnswers: Array<{ kind: string; text: string }> };

/** Open-question group: each answer must be taken by every kind of question; each new request must not. */
function scorePending(file: EvalFile, set: PendingSet): void {
  const ctx = parseCtx({ now: new Date(file.now), tz: file.timezone });
  const failures: string[] = [];
  let total = 0;
  for (const p of set.kinds) {
    for (const text of set.answers) {
      total += 1;
      if (!isPlausibleAnswer(p as never, text, ctx)) failures.push(`  ${p.kind} + "${text}": not taken as an answer`);
    }
  }
  for (const row of set.notAnswers) {
    total += 1;
    const p = set.kinds.find((k) => k.kind === row.kind);
    if (p && isPlausibleAnswer(p as never, row.text, ctx)) failures.push(`  ${row.kind} + "${row.text}": a new request taken as an answer`);
  }
  const ok = total - failures.length;
  console.log(`\npending (open question + reply): ${ok}/${total} = ${((ok / total) * 100).toFixed(1)}%`);
  console.log(failures.length ? `Failures (${failures.length}):\n${failures.join("\n")}` : "No failures.");
}

function score(file: EvalFile, label: string): void {
  const rows: Row[] = [
    ...(file.messages ?? []).map((m) => ({ id: m.id, lang: m.lang, text: m.text, command: m.intent, alsoOk: m.alsoOk })),
    ...(file.commands ?? []).filter((r) => !r.example),
  ];
  if (!rows.length) {
    console.log(`\n${label}: no scored rows yet.`);
    return;
  }
  const ctx = parseCtx({ now: new Date(file.now), tz: file.timezone, contexts: ["At Home", "At Work", "At University"] });
  const per = new Map<string, { n: number; ok: number }>();
  const perLang = new Map<string, { n: number; ok: number }>();
  const failures: string[] = [];
  for (const row of rows) {
    const got = classify(row.text, ctx, { baseline });
    const commandOk = got.command === row.command || (row.alsoOk ?? []).includes(got.command);
    const argProblem = commandOk && got.command === row.command ? argsMatch(row.args, got.args) : null;
    const ok = commandOk && !argProblem;
    for (const [map, key] of [[per, row.command], [perLang, row.lang ?? "?"]] as const) {
      const e = map.get(key) ?? { n: 0, ok: 0 };
      e.n += 1;
      if (ok) e.ok += 1;
      map.set(key, e);
    }
    if (!ok) failures.push(`  ${row.id} [${row.lang ?? "?"}] "${row.text}"\n      expected ${row.command}${row.args ? ` ${JSON.stringify(row.args)}` : ""}, got ${got.command} ${JSON.stringify(got.args)}${argProblem ? `  (${argProblem})` : ""}`);
  }
  const total = rows.length;
  const correct = total - failures.length;
  const pct = (ok: number, n: number) => `${((ok / n) * 100).toFixed(1)}%`;
  console.log(`\n${label}${baseline ? " (baseline: rules before the command registry)" : ""}: ${correct}/${total} = ${pct(correct, total)}`);
  console.log(`By language: ${[...perLang.entries()].map(([k, v]) => `${k} ${v.ok}/${v.n}`).join(", ")}`);
  console.log("\nCommand                     n   correct  accuracy");
  for (const [name, v] of [...per.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`${name.padEnd(26)} ${String(v.n).padStart(3)}  ${String(v.ok).padStart(7)}  ${pct(v.ok, v.n).padStart(8)}`);
  }
  console.log(failures.length ? `\nFailures (${failures.length}):\n${failures.join("\n")}` : "\nNo failures.");
}

const main = JSON.parse(readFileSync(join(root, "tests/eval/assistant-eval.json"), "utf8")) as EvalFile & { pending?: PendingSet };
score(main, "assistant-eval.json");
if (main.pending && !baseline) scorePending(main, main.pending);
score(JSON.parse(readFileSync(join(root, "tests/eval/chat-holdout.json"), "utf8")) as EvalFile, "chat-holdout.json (held out, never tuned on)");
process.exit(0);
