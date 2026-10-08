/**
 * Local model benchmark for the FYP report. Does not change app behaviour.
 *
 *   cd backend && npx tsx scripts/model-benchmark.ts [model ...]
 *   default models: qwen2.5:7b qwen3.5:9b qwen3.5:4b
 *
 * Uses the exact prompts and options the app sends (nluMessages / NLU_LLM_OPTIONS,
 * stepPrompt / FIRST_STEP_OPTIONS) through OllamaProvider (think:false, OLLAMA_NUM_CTX),
 * calling the model directly — no rules, no circuit breaker, no retries — once per item.
 * Writes docs/model-benchmark.md and backend/tests/eval/results/model-benchmark-<timestamp>.csv.
 */
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyProviderError, extractJson, OllamaProvider, type CompletionOptions } from "../src/ai/llm.js";
import { cleanTitle, extractEntities } from "../src/modules/assistant/entities.js";
import { NLU_LLM_OPTIONS, NLU_LLM_SCHEMA, nluMessages } from "../src/modules/assistant/nlu.js";
import { FIRST_STEP_OPTIONS, stepPrompt, stepSchema, validateFirstStep } from "../src/modules/checkins/copy.js";
import type { Lang } from "../src/modules/checkins/templates.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const BASE = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
const MODELS = process.argv.slice(2).length ? process.argv.slice(2) : ["qwen2.5:7b", "qwen3.5:9b", "qwen3.5:4b"];

type Msg = { id: string; lang: string; text: string; intent: string; alsoOk?: string[]; title?: string; titleAlt?: string[]; date?: string; time?: string; duration?: number };
type Step = { id: string; title: string; durationMinutes: number };
const evalSet = JSON.parse(readFileSync(join(root, "tests/eval/assistant-eval.json"), "utf8")) as { now: string; timezone: string; messages: Msg[]; firstSteps: Step[] };
const NOW = new Date(evalSet.now);
const TZ = evalSet.timezone;

type Row = {
  model: string; type: "nlu" | "first_step"; id: string; lang: string; input: string; expected: string; got: string;
  correct: string; jsonValid: boolean; latencyMs: number; error: string;
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : NaN);
const p90 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.9) - 1)] : NaN);
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");
const csv = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;

async function ollama(path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  return res.json();
}
async function loadedModels(): Promise<Array<{ name: string; size: number; size_vram: number }>> {
  return ((await ollama("/api/ps")).models ?? []) as Array<{ name: string; size: number; size_vram: number }>;
}
async function unloadAll(): Promise<void> {
  for (const m of await loadedModels()) await ollama("/api/generate", { model: m.name, keep_alive: 0 });
}

/** Same as AiService.json: temperature 0.1 unless the call sets one. */
async function call(provider: OllamaProvider, messages: Parameters<OllamaProvider["chat"]>[0], options: CompletionOptions) {
  const started = performance.now();
  try {
    const text = await provider.chat(messages, { temperature: 0.1, ...options });
    return { text, ms: Math.round(performance.now() - started), error: "" };
  } catch (e) {
    return { text: "", ms: Math.round(performance.now() - started), error: classifyProviderError(e) === "timeout" ? "timeout" : e instanceof Error ? e.message : String(e) };
  }
}

async function bench(model: string): Promise<{ rows: Row[]; peakBytes: number; peakVram: number }> {
  const provider = new OllamaProvider(BASE, model);
  const rows: Row[] = [];
  let peakBytes = 0;
  let peakVram = 0;
  const sample = async () => {
    const m = (await loadedModels()).find((x) => x.name === model || x.name.startsWith(`${model}`));
    if (m) {
      peakBytes = Math.max(peakBytes, m.size);
      peakVram = Math.max(peakVram, m.size_vram);
    }
  };

  // Warm-up (not counted): loads the model so latency excludes load time.
  await call(provider, nluMessages("hello", { history: [] }), NLU_LLM_OPTIONS);
  await sample();

  for (const m of evalSet.messages) {
    const r = await call(provider, nluMessages(m.text, { history: [] }), NLU_LLM_OPTIONS);
    await sample();
    let parsed: ReturnType<typeof NLU_LLM_SCHEMA.safeParse> | null = null;
    try {
      parsed = NLU_LLM_SCHEMA.safeParse(extractJson(r.text));
    } catch {
      parsed = null;
    }
    const ok = Boolean(parsed?.success);
    const intent = parsed?.success ? parsed.data.intent : "";
    const intentOk = intent === m.intent || Boolean(m.alsoOk?.includes(intent));
    const title = parsed?.success ? cleanTitle(parsed.data.task_title ?? "") : "";
    const titleScored = Boolean(m.title) && (m.intent === "create_task" || m.intent === "create_routine");
    const titleOk = titleScored ? [m.title!, ...(m.titleAlt ?? [])].some((t) => norm(t) === norm(title)) : null;
    rows.push({
      model, type: "nlu", id: m.id, lang: m.lang, input: m.text,
      expected: `${m.intent}${m.title ? ` | ${m.title}` : ""}`,
      got: `${intent}${title ? ` | ${title}` : ""}`,
      correct: `intent=${intentOk}${titleOk === null ? "" : ` title=${titleOk}`}`,
      jsonValid: ok, latencyMs: r.ms, error: r.error,
    });
  }

  for (const task of evalSet.firstSteps) {
    for (const lang of ["en", "ur"] as Lang[]) {
      const t = { id: task.id, title: task.title, durationMinutes: task.durationMinutes, scheduledStart: NOW };
      const r = await call(provider, [{ role: "user", content: stepPrompt(t, lang) }], FIRST_STEP_OPTIONS);
      await sample();
      let step = "";
      let ok = false;
      try {
        const p = stepSchema.safeParse(extractJson(r.text));
        ok = p.success;
        if (p.success) step = p.data.firstStep.trim().replace(/[.!۔]+$/, "").trim();
      } catch {
        ok = false;
      }
      rows.push({
        model, type: "first_step", id: task.id, lang, input: task.title, expected: "valid first step", got: step,
        correct: `valid=${Boolean(step) && validateFirstStep(step, lang, task.title)}`, jsonValid: ok, latencyMs: r.ms, error: r.error,
      });
    }
  }
  return { rows, peakBytes, peakVram };
}

/** Deterministic extractor accuracy (model-independent): date / time / duration come from code, not the LLM. */
function deterministicFields() {
  const out: Array<{ id: string; field: string; expected: string; got: string; ok: boolean }> = [];
  for (const m of evalSet.messages) {
    const e = extractEntities(m.text, { now: NOW, tz: TZ, contexts: [] });
    if (m.date) out.push({ id: m.id, field: "date", expected: m.date, got: e.date?.ymd ?? "", ok: e.date?.ymd === m.date });
    if (m.time) out.push({ id: m.id, field: "time", expected: m.time, got: e.time ?? "", ok: e.time === m.time });
    if (m.duration) out.push({ id: m.id, field: "duration", expected: String(m.duration), got: String(e.durationMinutes ?? ""), ok: e.durationMinutes === m.duration });
  }
  return out;
}

async function main() {
  const installed = new Set(((await ollama("/api/tags")).models ?? []).map((m: { name: string }) => m.name));
  const results: Array<{ model: string; rows: Row[]; peakBytes: number; peakVram: number }> = [];
  for (const model of MODELS) {
    if (!installed.has(model)) {
      console.warn(`skip ${model}: not installed (ollama pull ${model})`);
      continue;
    }
    await unloadAll();
    console.log(`\n=== ${model}`);
    const r = await bench(model);
    results.push({ model, ...r });
    await ollama("/api/generate", { model, keep_alive: 0 });
    const n = r.rows.filter((x) => x.type === "nlu");
    console.log(`intent ${pct(n.filter((x) => x.correct.includes("intent=true")).length, n.length)}, json ${pct(n.filter((x) => x.jsonValid).length, n.length)}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = join(root, "tests/eval/results");
  mkdirSync(resultsDir, { recursive: true });
  const header = ["model", "type", "id", "lang", "input", "expected", "got", "correct", "jsonValid", "latencyMs", "error"];
  const lines = [header.join(","), ...results.flatMap((r) => r.rows.map((x) => header.map((h) => csv((x as Record<string, unknown>)[h])).join(",")))];
  const csvPath = join(resultsDir, `model-benchmark-${stamp}.csv`);
  writeFileSync(csvPath, `${lines.join("\n")}\n`);

  const det = deterministicFields();
  const md: string[] = [];
  md.push("# Local model benchmark", "");
  md.push(`Run: ${new Date().toISOString()} · Ollama ${(await ollama("/api/version")).version} · think:false · num_ctx ${process.env.OLLAMA_NUM_CTX ?? 4096} · one run per item, warm model (load time excluded).`, "");
  md.push(`Inputs: \`backend/tests/eval/assistant-eval.json\` (${evalSet.messages.length} chat messages, English + Roman Urdu; ${evalSet.firstSteps.length} first-step tasks × en/ur). Raw rows: \`backend/tests/eval/results/${csvPath.split("/").pop()}\`.`, "");
  md.push("The LLM intent step is called **directly** (rules bypassed). In the app, rules answer most messages first and the LLM is only asked when they are unsure.", "");
  md.push("## Summary", "");
  md.push("| Model | Intent accuracy | Title accuracy | JSON valid | First step valid (en) | First step valid (ur) | Intent latency median / p90 | First-step latency median / p90 | Peak memory (VRAM) | Timeouts |");
  md.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const n = r.rows.filter((x) => x.type === "nlu");
    const f = r.rows.filter((x) => x.type === "first_step");
    const titled = n.filter((x) => x.correct.includes("title="));
    const fl = (lang: string) => f.filter((x) => x.lang === lang);
    const ms = (xs: Row[]) => xs.filter((x) => !x.error).map((x) => x.latencyMs);
    md.push(
      `| ${r.model} | ${pct(n.filter((x) => x.correct.includes("intent=true")).length, n.length)} | ${pct(titled.filter((x) => x.correct.includes("title=true")).length, titled.length)} | ${pct(r.rows.filter((x) => x.jsonValid).length, r.rows.length)} | ${pct(fl("en").filter((x) => x.correct === "valid=true").length, fl("en").length)} | ${pct(fl("ur").filter((x) => x.correct === "valid=true").length, fl("ur").length)} | ${median(ms(n))} / ${p90(ms(n))} ms | ${median(ms(f))} / ${p90(ms(f))} ms | ${(r.peakBytes / 1e9).toFixed(1)} GB (${(r.peakVram / 1e9).toFixed(1)} GB) | ${r.rows.filter((x) => x.error === "timeout").length} |`,
    );
  }
  md.push("", "## Deterministic fields (same for every model)", "");
  md.push("Dates, times and durations are extracted by code (`assistant/entities.ts`), never by the LLM, so they are measured once:", "");
  for (const field of ["date", "time", "duration"]) {
    const xs = det.filter((d) => d.field === field);
    md.push(`- **${field}:** ${pct(xs.filter((d) => d.ok).length, xs.length)} (${xs.filter((d) => d.ok).length}/${xs.length})${xs.some((d) => !d.ok) ? ` — missed: ${xs.filter((d) => !d.ok).map((d) => `${d.id} (expected ${d.expected}, got ${d.got || "none"})`).join(", ")}` : ""}`);
  }
  md.push("", "## Intent errors", "");
  md.push("| Model | Message | Expected | Got |", "|---|---|---|---|");
  for (const r of results) for (const x of r.rows.filter((y) => y.type === "nlu" && !y.correct.includes("intent=true"))) md.push(`| ${r.model} | ${x.input} | ${x.expected.split(" | ")[0]} | ${x.got.split(" | ")[0] || (x.error ? `error: ${x.error}` : "invalid JSON")} |`);
  md.push("", "## All first steps", "");
  md.push("✓ passes `validateFirstStep`, ✗ rejected.", "");
  md.push(`| Task | Lang | ${results.map((r) => r.model).join(" | ")} |`, `|---|---|${results.map(() => "---").join("|")}|`);
  for (const task of evalSet.firstSteps) {
    for (const lang of ["en", "ur"]) {
      const cells = results.map((r) => {
        const x = r.rows.find((y) => y.type === "first_step" && y.id === task.id && y.lang === lang);
        if (!x) return "—";
        if (!x.got) return x.error ? `error: ${x.error}` : "invalid JSON";
        return `${x.correct === "valid=true" ? "✓" : "✗"} ${x.got.replace(/\|/g, "/")}`;
      });
      md.push(`| ${task.title} | ${lang} | ${cells.join(" | ")} |`);
    }
  }
  writeFileSync(join(root, "../docs/model-benchmark.md"), `${md.join("\n")}\n`);
  console.log(`\nwrote docs/model-benchmark.md and ${csvPath}`);
}

await main();
process.exit(0);
