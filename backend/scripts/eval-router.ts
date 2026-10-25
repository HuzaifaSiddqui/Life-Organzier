/**
 * Gate for the meaning-based router: `npm run eval:router` (AI off: hashed vectors, no model) or
 * `npm run eval:router -- --model` (the embedding model and the LLM router from backend/.env).
 *
 * Leave-one-out over tests/eval/utterance-bank.json, per language (English, Roman Urdu): each row is routed with
 * every other row as the bank. Scores the command (alsoOk counts) for rules alone, neighbours alone and the
 * combined path (meaningRoute, the code the chat runs). Also: how often the combined path asks a question on rows
 * the rules already get right, and the time added per message. tests/eval/chat-holdout.json is scored separately
 * with the whole bank and is never used for rules, examples or thresholds.
 */
const useModel = process.argv.includes("--model");
if (useModel) await import("dotenv/config");
else {
  process.env.AI_ENABLED = "false";
  process.env.GEMINI_API_KEY = "";
}

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { classify, matchCommand, parseCtx } = await import("../src/modules/assistant/commands/registry.js");
const { parseMulti } = await import("../src/modules/assistant/commands/multi.js");
const { rulesUnderstand } = await import("../src/modules/assistant/nlu.js");
const { meaningRoute, RULES_SURE } = await import("../src/modules/assistant/commands/meaning.js");
const { bankIndex, loadBank, nearest, vote } = await import("../src/modules/assistant/commands/neighbours.js");
type Row = { id: string; text: string; lang: string; command: string; alsoOk?: string[] };

const ctx = parseCtx({ now: new Date("2026-10-05T05:00:00.000Z"), tz: "Asia/Karachi", contexts: ["At Home", "At Work", "At University"] });

/** The rules' command and how sure they are (a registry match or two requests in one message: fully sure). */
function rulesFor(text: string): { command: string; confidence: number } {
  const c = classify(text, ctx);
  const sure = Boolean(parseMulti(text, ctx) || matchCommand(text, ctx));
  return { command: c.command, confidence: sure ? 1 : rulesUnderstand(text, ctx.opts).confidence };
}
const right = (row: Row, command: string) => command === row.command || (row.alsoOk ?? []).includes(command);
const pct = (ok: number, n: number) => (n ? `${((ok / n) * 100).toFixed(1)}%` : "–");
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

const bank = loadBank() as Row[];
const index = await bankIndex(useModel, bank);
console.log(`Bank: ${bank.length} rows (en + Roman Urdu); vectors: ${index.model}; model router: ${useModel ? "on" : "off"}`);

type Tally = { n: number; rules: number; neighbours: number; combined: number; oldRouter: number; asked: number; askedOnRight: number; rulesRight: number; routed: number; unknown: number };
const tallies = new Map<string, Tally>();
const added: number[] = [];
const addedModel: number[] = [];
const misses: string[] = [];
for (const row of bank) {
  const t = tallies.get(row.lang) ?? { n: 0, rules: 0, neighbours: 0, combined: 0, oldRouter: 0, asked: 0, askedOnRight: 0, rulesRight: 0, routed: 0, unknown: 0 };
  tallies.set(row.lang, t);
  t.n += 1;
  const rules = rulesFor(row.text);
  const rulesOk = right(row, rules.command);
  const v = vote(await nearest(row.text, index, { exclude: row.id }));
  const res = await meaningRoute(row.text, ctx, rules, { index, model: useModel, exclude: row.id });
  // Baseline with the model on: the LLM router as before (rules unsure → model, no examples, no neighbour opinion).
  if (useModel) {
    const { routeWithLlm } = await import("../src/modules/assistant/commands/router.js");
    const old = rules.confidence < 0.75 ? await routeWithLlm(row.text, ctx) : null;
    if (right(row, old?.command ?? rules.command)) t.oldRouter += 1;
  }
  const d = res.decision;
  const combined = d.kind === "route" ? d.command : d.kind === "unknown" ? "unclear" : d.kind === "ask" ? "(asked)" : rules.command;
  // An arbitration question offering the right command is not a wrong action; it is counted as asked, not right.
  const combinedOk = d.kind !== "ask" && right(row, combined);
  if (rulesOk) t.rules += 1;
  if (v.command && right(row, v.command)) t.neighbours += 1;
  if (combinedOk) t.combined += 1;
  if (rulesOk) t.rulesRight += 1;
  if (d.kind === "ask") {
    t.asked += 1;
    if (rulesOk) t.askedOnRight += 1;
  }
  if (d.kind === "route") t.routed += 1;
  if (d.kind === "unknown") t.unknown += 1;
  added.push(res.ms.neighbours + res.ms.model);
  if (res.ms.model) addedModel.push(res.ms.neighbours + res.ms.model);
  if (rulesOk !== combinedOk) misses.push(`  ${combinedOk ? "+" : "-"} ${row.id} [${row.lang}] "${row.text}" expected ${row.command}; rules ${rules.command} (${rules.confidence.toFixed(2)}), combined ${combined}${d.kind === "route" ? ` via ${d.via}` : ""}`);
}

const LANG = { en: "English", ru: "Roman Urdu" } as Record<string, string>;
console.log(`\nLeave-one-out, command accuracy (rules sure = ${RULES_SURE}+)`);
console.log(`Language     n    rules   neighbours${useModel ? "  rules+model (before)" : ""}  combined  routed  unknown  asked  asked-on-rules-right`);
const summary: Record<string, unknown> = {};
for (const [lang, t] of tallies) {
  console.log(`${(LANG[lang] ?? lang).padEnd(11)} ${String(t.n).padStart(3)}  ${pct(t.rules, t.n).padStart(7)}  ${pct(t.neighbours, t.n).padStart(10)}  ${useModel ? pct(t.oldRouter, t.n).padStart(20) + "  " : ""}${pct(t.combined, t.n).padStart(8)}  ${String(t.routed).padStart(6)}  ${String(t.unknown).padStart(7)}  ${String(t.asked).padStart(5)}  ${t.askedOnRight}/${t.rulesRight} = ${pct(t.askedOnRight, t.rulesRight)}`);
  summary[lang] = { ...t, rulesAcc: t.rules / t.n, neighboursAcc: t.neighbours / t.n, combinedAcc: t.combined / t.n, verdict: t.combined > t.rules ? "beats rules" : "does not beat rules", ...(useModel ? { oldRouterAcc: t.oldRouter / t.n } : {}) };
}
console.log(`\nAdded time per message: median ${quantile(added, 0.5).toFixed(1)} ms, p95 ${quantile(added, 0.95).toFixed(1)} ms (all ${added.length} messages)`);
if (addedModel.length) console.log(`  messages that called the model (${addedModel.length}): median ${quantile(addedModel, 0.5).toFixed(0)} ms, p95 ${quantile(addedModel, 0.95).toFixed(0)} ms`);
console.log(misses.length ? `\nWhere combined differs from rules (+ fixed, - broken):\n${misses.join("\n")}` : "\nCombined never differs from rules.");

// Held-out: never tuned on; the whole bank is the index.
const holdout = (JSON.parse(readFileSync(join(root, "tests/eval/chat-holdout.json"), "utf8")) as { commands: Array<Row & { example?: boolean }> }).commands.filter((r) => !r.example && r.lang !== "ur");
if (!holdout.length) console.log("\nchat-holdout.json: no scored rows yet (only examples), so there is no held-out number.");
else {
  let r = 0;
  let c = 0;
  for (const row of holdout) {
    const rules = rulesFor(row.text);
    const res = await meaningRoute(row.text, ctx, rules, { index, model: useModel });
    if (right(row, rules.command)) r += 1;
    const d = res.decision;
    if (d.kind !== "ask" && right(row, d.kind === "route" ? d.command : d.kind === "unknown" ? "unclear" : rules.command)) c += 1;
  }
  console.log(`\nchat-holdout.json (held out): rules ${pct(r, holdout.length)}, combined ${pct(c, holdout.length)} of ${holdout.length}`);
}

mkdirSync(join(root, "tests/eval/results"), { recursive: true });
writeFileSync(join(root, `tests/eval/results/router-eval${useModel ? "-model" : ""}.json`), JSON.stringify({ vectors: index.model, model: useModel, summary, addedMs: { median: quantile(added, 0.5), p95: quantile(added, 0.95) }, addedModelMs: addedModel.length ? { median: quantile(addedModel, 0.5), p95: quantile(addedModel, 0.95), n: addedModel.length } : null }, null, 1));
process.exit(0);
