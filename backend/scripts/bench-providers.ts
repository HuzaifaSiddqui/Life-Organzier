/**
 * Provider benchmark: `npx tsx scripts/bench-providers.ts --provider groq[,cerebras…] [--job chat|docs|vision|embed|all]
 * [--model id] [--max 40] [--runs 3] [--rank]`. Never prints keys. Every hosted provider gets masked text only.
 *
 * Jobs (the app's own prompts and validation):
 * English only until after the FYP evaluation (10 Nov 2026): Roman Urdu / Urdu rows and fixtures are skipped.
 * - chat: the LLM router (routeWithLlm) on English messages the rules are unsure about: the never-tuned paraphrase
 *   review rows (labels = the command they were written for, not reviewed) and bank rows (tuned: reported
 *   separately). chat-holdout.json is never read. --fewshot: the router also gets the 5 nearest English bank rows
 *   (the app's own kNN, commands/neighbours.ts, nomic-embed-text), leave-one-out: the message itself is never one.
 * - docs: llmActionItems through aiDeadlines on the English synthetic text fixtures with deadlines (ranked), plus one
 *   joined document reported separately ("long"); scored like npm run eval:documents (title contains + date [+ time]).
 * - vision: synthetic images only (no personal data): the generated date-sheet screenshot and grid timetable.
 * - embed: leave-one-out neighbours on the English and Roman Urdu bank rows, against the hashed fallback.
 * Each provider/model/job runs --runs times (OpenRouter: once, 50 free requests a day). Results:
 * docs/baselines/providers-<date>.json (+ .md with --rank, which also writes config/provider-order.json from ALL saved
 * runs of that date). Stops a provider at the first billing sign (HTTP 402 or a reported cost).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = parse(readFileSync(join(root, ".env")));
for (const [k, v] of Object.entries(env)) if (!(k in process.env) && !/^(?:TWILIO_|EXPO_|DATABASE_URL)/.test(k)) process.env[k] = v;
process.env.LLM_LOG = "off";
process.env.UNKNOWN_LOG = "off";

const arg = (name: string) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined);
const providersArg = (arg("provider") ?? "").split(",").filter(Boolean);
const jobArg = arg("job") ?? "all";
const modelArg = arg("model");
const MAX = Number(arg("max") ?? 40);
const RUNS = Number(arg("runs") ?? 3);
/** --pace ms between calls (overrides the per-provider default); --tag names the pass (e.g. slow) in the results. */
const PACE_ARG = arg("pace") ? Number(arg("pace")) : null;
const TAG = arg("tag") ?? "";
const FEWSHOT = process.argv.includes("--fewshot");
/** --timeout ms per hosted call (default 8000, the production limit); a longer one is a diagnostic pass, never ranked. */
const TIMEOUT = Number(arg("timeout") ?? 8000);
const DATE = arg("date") ?? new Date().toISOString().slice(0, 10);
const OUT = join(root, `../docs/baselines/providers-${DATE}.json`);

const { AiService, setAi, extractJson } = await import("../src/ai/llm.js");
const { OllamaProvider } = await import("../src/ai/llm.js");
const { makeProvider, providerSpecs } = await import("../src/ai/providers.js");
const { maskForProvider } = await import("../src/lib/mask.js");
const { embedHosted, hashEmbedding, embedTexts } = await import("../src/ai/embeddings.js");
await import("../src/modules/assistant/commands/registry.js");
const { classify, matchCommand, parseCtx } = await import("../src/modules/assistant/commands/registry.js");
const { parseMulti } = await import("../src/modules/assistant/commands/multi.js");
const { rulesUnderstand } = await import("../src/modules/assistant/nlu.js");
const { routeWithLlm } = await import("../src/modules/assistant/commands/router.js");
const { aiDeadlines } = await import("../src/modules/documents/extraction.js");
const { bankIndex, loadBank, nearest } = await import("../src/modules/assistant/commands/neighbours.js");
const { bootstrapCi, pairedDiffCi } = await import("./bootstrap.js");
type Msg = { role: "system" | "user" | "assistant"; content: string };

const NOW = new Date("2026-10-05T05:00:00.000Z");
const TZ = "Asia/Karachi";
const opts = { now: NOW, tz: TZ };
const ctx = parseCtx({ ...opts, contexts: ["At Home", "At Work", "At University"] });
/** Gap between calls (ms), under each free tier's per-minute cap. */
const PACE: Record<string, number> = { ollama: 0, groq: 2500, cerebras: 2500, gemini: 5000, openrouter: 3500, deploy: 2000, together: 2500 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quantile = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] : 0);

/* ------------------------------------------------------------------ the measured provider */

type Tally = { errors: Record<string, number>; calls: number; invalidJson: number; schemaFail: number; failures: number; rateLimited: number; billing: number; inputTokens: number; outputTokens: number; latencies: number[]; headroom: number | null };
function measured(name: string, model: string, needKeys: string[] | null) {
  const inner = name === "ollama" ? new OllamaProvider(undefined, model) : makeProvider(name, model);
  if (!inner) throw new Error(`${name}/${model}: not configured`);
  const t: Tally = { errors: {}, calls: 0, invalidJson: 0, schemaFail: 0, failures: 0, rateLimited: 0, billing: 0, inputTokens: 0, outputTokens: 0, latencies: [], headroom: null };
  let last = 0;
  let stopped = false;
  const provider = {
    name,
    model,
    chat: async (messages: Msg[], options: Record<string, unknown>): Promise<string> => {
      if (stopped) throw new Error("stopped: billing");
      const wait = last + (PACE_ARG ?? PACE[name] ?? 2500) - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      const sent = name === "ollama" ? messages : messages.map((m) => ({ ...m, content: maskForProvider(m.content) }));
      t.calls += 1;
      const t0 = performance.now();
      try {
        const r = inner.call ? await inner.call(sent, { ...options, timeoutMs: name === "ollama" ? 60000 : TIMEOUT }) : { text: await inner.chat(sent, options) };
        t.latencies.push(performance.now() - t0);
        const u = "usage" in r ? r.usage : undefined;
        t.inputTokens += u?.inputTokens ?? 0;
        t.outputTokens += u?.outputTokens ?? 0;
        if ((u?.costUsd ?? 0) > 0) {
          t.billing += 1;
          stopped = true; // $0 cap
        }
        const rl = (inner as { rateLimit?: { remainingRequests: number } | null }).rateLimit;
        if (rl && Number.isFinite(rl.remainingRequests)) t.headroom = rl.remainingRequests;
        if (options.json) {
          try {
            const parsed = extractJson(r.text) as Record<string, unknown>;
            if (needKeys && !needKeys.some((k) => k in (parsed ?? {}))) t.schemaFail += 1;
          } catch {
            t.invalidJson += 1;
          }
        }
        return r.text;
      } catch (error) {
        t.latencies.push(performance.now() - t0);
        t.failures += 1;
        const msg = error instanceof Error ? error.message : String(error);
        // Cause only (HTTP status, timeout, empty reply), never the message body.
        const cause = /HTTP (\d{3})/.exec(msg)?.[1] ?? (/timeout|abort/i.test(msg) ? "timeout" : /empty/i.test(msg) ? "empty" : "other");
        t.errors[cause] = (t.errors[cause] ?? 0) + 1;
        if (/HTTP 429/.test(msg)) t.rateLimited += 1;
        if (/json_validate_failed/.test(msg)) t.invalidJson += 1; // the provider rejected the model's reply as not JSON
        if (/HTTP 402/.test(msg)) {
          t.billing += 1;
          stopped = true;
        }
        throw error;
      }
    },
  };
  return { provider, tally: t, stopped: () => stopped };
}

/* ------------------------------------------------------------------ data */

const bank = (JSON.parse(readFileSync(join(root, "tests/eval/utterance-bank.json"), "utf8")) as { rows: Array<{ id: string; text: string; lang: string; command: string; alsoOk?: string[] }> }).rows.filter((r) => r.lang === "en" || r.lang === "ru");
const para = JSON.parse(readFileSync(join(root, "tests/eval/review/paraphrases-review.json"), "utf8")) as Array<{ text: string; lang: string; command: string }>;
const unsure = (t: string) => !parseMulti(t, ctx) && !matchCommand(t, ctx) && rulesUnderstand(t, opts).confidence < 0.75;
const chatSet = [
  ...para.filter((r) => unsure(r.text)).map((r) => ({ text: r.text, lang: "en", command: r.command, alsoOk: [] as string[], set: "en-untuned" })),
  ...bank.filter((r) => r.lang === "en" && unsure(r.text)).map((r) => ({ ...r, alsoOk: r.alsoOk ?? [], set: "en-bank(tuned)" })),
] as Array<{ id?: string; text: string; lang: string; command: string; alsoOk: string[]; set: string }>;

type Exp = { titleContains: string; date: string | null; time?: string };
const manifest = JSON.parse(readFileSync(join(root, "tests/eval/documents/manifest.json"), "utf8")) as { documents: Array<{ file: string; from?: string; expectedDeadlines?: Exp[] }> };
const docSet = manifest.documents.filter((d) => !d.from && (d.expectedDeadlines ?? []).length && !/urdu/i.test(d.file)).map((d) => ({ name: d.file, text: readFileSync(join(root, "tests/eval/documents", d.file), "utf8"), expected: d.expectedDeadlines ?? [] }));
const longDoc = { name: "long (all fixtures joined)", text: docSet.map((d) => d.text).join("\n\n----\n\n"), expected: docSet.flatMap((d) => d.expected) };

/* ------------------------------------------------------------------ jobs */

type JobResult = { tag?: string; pace?: number; at?: string; /** 1/0 per scored item, in set order (bootstrap) */ items?: number[]; provider: string; model: string; job: string; run: number; n: number; correct: number; accuracy: number; bySet?: Record<string, { n: number; correct: number }>; tally: Omit<Tally, "latencies"> & { p50: number; p95: number }; note?: string };

function summary(t: Tally) {
  const { latencies, ...rest } = t;
  return { ...rest, p50: Math.round(quantile(latencies, 0.5)), p95: Math.round(quantile(latencies, 0.95)) };
}

async function chatJob(name: string, model: string, run: number, max: number): Promise<JobResult> {
  const m = measured(name, model, ["category", "command"]);
  setAi(new AiService([m.provider as never]));
  const items = chatSet.slice(0, max);
  const bySet: Record<string, { n: number; correct: number }> = {};
  const perItem: number[] = [];
  let correct = 0;
  const index = FEWSHOT ? await bankIndex(true, loadBank().filter((r) => r.lang === "en")) : null;
  for (const it of items) {
    if (m.stopped()) break;
    setAi(new AiService([m.provider as never])); // fresh per message: the service's own cooldown must not hide later answers
    // What the app would do for an unsure message: the routed command, else the rules' intent.
    // Leave-one-out: never the message itself (same bank row, or the same text).
    const examples = index ? (await nearest(it.text, index, { k: 6, exclude: it.id })).filter((n) => n.row.text.trim().toLowerCase() !== it.text.trim().toLowerCase()).slice(0, 5).map((n) => ({ text: n.row.text, command: n.row.command })) : [];
    const routed = await routeWithLlm(it.text, ctx, examples).catch(() => null);
    const final = routed?.command ?? classify(it.text, ctx).command;
    const ok = final === it.command || it.alsoOk.includes(final);
    if (ok) correct += 1;
    perItem.push(ok ? 1 : 0);
    const s = (bySet[it.set] ??= { n: 0, correct: 0 });
    s.n += 1;
    if (ok) s.correct += 1;
  }
  const n = Object.values(bySet).reduce((a, s) => a + s.n, 0);
  return { provider: name, model, job: "chat", run, n, correct, accuracy: n ? correct / n : 0, bySet, items: perItem, tally: summary(m.tally), ...(index ? { note: `few-shot: ${index.model}` } : {}) };
}

function scoreItems(items: Array<{ title: string; date: string | null; time: string | null }>, expected: Exp[]) {
  const used = new Set<number>();
  const hits: number[] = [];
  for (const e of expected) {
    const i = items.findIndex((d, k) => !used.has(k) && d.title.toLowerCase().includes(e.titleContains.toLowerCase()) && d.date === e.date && (!e.time || d.time === e.time));
    if (i >= 0) used.add(i);
    hits.push(i >= 0 ? 1 : 0);
  }
  return { found: used.size, hits, extracted: items.length, correct: used.size };
}

async function docsJob(name: string, model: string, run: number, max: number): Promise<JobResult> {
  const m = measured(name, model, ["items"]);
  setAi(new AiService([m.provider as never]));
  let expected = 0;
  let found = 0;
  let extracted = 0;
  const perItem: number[] = [];
  const docs = [...docSet.slice(0, Math.max(0, max - 1)), longDoc];
  const bySet: Record<string, { n: number; correct: number }> = {};
  for (const d of docs) {
    if (m.stopped()) break;
    setAi(new AiService([m.provider as never]));
    const r = await aiDeadlines(d.text, "2026-10-05", TZ, { budgetMs: 120000, maxChunks: name === "openrouter" ? 3 : 6 }).catch(() => ({ items: [] }));
    const s = scoreItems(r.items, d.expected);
    const key = d === longDoc ? "long" : "single";
    const b = (bySet[key] ??= { n: 0, correct: 0 });
    b.n += d.expected.length;
    b.correct += s.found;
    if (key === "long") continue; // reported in bySet only: it repeats the single fixtures
    perItem.push(...s.hits);
    expected += d.expected.length;
    found += s.found;
    extracted += s.extracted;
  }
  const precision = extracted ? found / extracted : 1;
  return { provider: name, model, job: "docs", run, n: expected, correct: found, accuracy: expected ? found / expected : 0, bySet, items: perItem, tally: summary(m.tally), note: `precision ${(precision * 100).toFixed(1)}% (${found}/${extracted})` };
}

/** The clean synthetic page images (no personal data) with the expectations of their text fixtures; times as 24 h. */
const to24 = (t?: string) => {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(t ?? "");
  if (!m) return "";
  const h = (Number(m[1]) % 12) + (m[3].toUpperCase() === "PM" ? 12 : 0);
  return `${String(h).padStart(2, "0")}:${m[2] ?? "00"}`;
};
const VISION = manifest.documents
  .filter((d) => d.from && d.file.endsWith(".clean.png"))
  .map((d) => ({ file: d.file, expect: (manifest.documents.find((x) => x.file === `fixtures/${d.from}.txt`)?.expectedDeadlines ?? []).map((e) => [e.titleContains.toLowerCase(), e.date ?? "", to24(e.time)]) }))
  .filter((v) => v.expect.length);
async function visionJob(name: string, model: string, run: number): Promise<JobResult> {
  const m = measured(name, model, ["items"]);
  let n = 0;
  let correct = 0;
  for (const v of VISION) {
    if (m.stopped()) break;
    const data = readFileSync(join(root, "tests/eval/documents", v.file)).toString("base64");
    n += v.expect.length;
    try {
      const text = await m.provider.chat(
        [
          { role: "system", content: 'Read the image. List every exam or deadline with its date. Return JSON {"items": [{"title": "...", "date": "YYYY-MM-DD", "time": "HH:MM 24h or empty"}]}. Today is 2026-10-05.' },
          { role: "user", content: "What is in this schedule?" },
        ],
        { json: true, images: [{ mimeType: "image/png", data }], maxTokens: 800, temperature: 0.1 },
      );
      const items = ((extractJson(text) as { items?: Array<{ title?: string; date?: string; time?: string }> }).items ?? []).map((i) => ({ title: String(i.title ?? "").toLowerCase(), date: i.date ?? "", time: String(i.time ?? "").replace(/^(\d):/, "0$1:") }));
      for (const [title, date, time] of v.expect) if (items.some((i) => i.title.includes(title) && i.date === date && i.time.startsWith(time))) correct += 1;
    } catch {
      // counted in the tally
    }
  }
  return { provider: name, model, job: "vision", run, n, correct, accuracy: n ? correct / n : 0, tally: summary(m.tally), note: "synthetic images only" };
}

function looAccuracy(vectors: number[][]) {
  const cos = (a: number[], b: number[]) => {
    let d = 0;
    let x = 0;
    let y = 0;
    for (let i = 0; i < a.length; i += 1) {
      d += a[i] * b[i];
      x += a[i] * a[i];
      y += b[i] * b[i];
    }
    return x && y ? d / Math.sqrt(x * y) : 0;
  };
  const bySet: Record<string, { n: number; correct: number }> = {};
  bank.forEach((row, i) => {
    const near = bank.map((r, k) => ({ r, s: k === i ? -2 : cos(vectors[i], vectors[k]) })).sort((a, b) => b.s - a.s).slice(0, 5);
    const w = new Map<string, number>();
    for (const n of near) w.set(n.r.command, (w.get(n.r.command) ?? 0) + Math.max(0, n.s));
    const best = [...w.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const s = (bySet[row.lang] ??= { n: 0, correct: 0 });
    s.n += 1;
    if (best === row.command || (row.alsoOk ?? []).includes(best ?? "")) s.correct += 1;
  });
  return bySet;
}
async function embedJob(name: string, model: string, run: number): Promise<JobResult> {
  const t0 = performance.now();
  let vectors: number[][];
  let note = name === "hash" ? "local hashed vectors" : "masked bank text";
  if (name === "hash") vectors = bank.map((r) => hashEmbedding(r.text));
  else if (name === "ollama") {
    const r = await embedTexts(bank.map((r) => r.text), "document");
    vectors = r.vectors;
    note = `local (${r.model}), unmasked`;
  } else vectors = await embedHosted(name as "openrouter" | "gemini", model, bank.map((r) => r.text), "document", 60000, 65000);
  const bySet = looAccuracy(vectors);
  const n = Object.values(bySet).reduce((a, s) => a + s.n, 0);
  const correct = Object.values(bySet).reduce((a, s) => a + s.correct, 0);
  const ms = performance.now() - t0;
  return { provider: name, model, job: "embed", run, n, correct, accuracy: correct / n, bySet, tally: { errors: {}, calls: name === "hash" ? 0 : Math.ceil(bank.length / 100), invalidJson: 0, schemaFail: 0, failures: 0, rateLimited: 0, billing: 0, inputTokens: 0, outputTokens: 0, headroom: null, p50: Math.round(ms), p95: Math.round(ms) }, note };
}

/* ------------------------------------------------------------------ run */

const candidates = (JSON.parse(readFileSync(join(root, "config/provider-candidates.json"), "utf8")) as { candidates: Record<string, Partial<Record<"chat" | "docs" | "vision" | "embed", string[]>>> }).candidates;
const saved: JobResult[] = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")) as { results: JobResult[] }).results : [];
// Re-read before each write and append only this process's new runs, so parallel runs (and hand re-tags) survive.
let written = saved.length;
const save = () => {
  const onDisk: JobResult[] = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")) as { results: JobResult[] }).results : [];
  const results = [...onDisk, ...saved.slice(written)];
  written = saved.length;
  writeFileSync(OUT, `${JSON.stringify({ date: DATE, about: "Raw provider benchmark results (scripts/bench-providers.ts). No keys, no prompts.", chatSet: { size: chatSet.length, sets: [...new Set(chatSet.map((c) => c.set))] }, docSet: { documents: docSet.length, long: longDoc.text.length }, results }, null, 1)}\n`);
};

if (!process.argv.includes("--rank")) {
  if (!providersArg.length) throw new Error("--provider is required (e.g. --provider groq)");
  const jobs = jobArg === "all" ? (["chat", "docs", "vision", "embed"] as const) : ([jobArg] as Array<"chat" | "docs" | "vision" | "embed">);
  for (const name of providersArg) {
    for (const job of jobs) {
      const models = name === "hash" ? (job === "embed" ? ["bag-of-words"] : []) : modelArg ? [modelArg] : (candidates[name]?.[job] ?? []);
      if (job === "vision" && name !== "hash" && !providerSpecs()[name]?.images) continue;
      for (const model of models) {
        const runs = name === "openrouter" ? 1 : job === "embed" && name === "hash" ? 1 : RUNS;
        for (let run = 1; run <= runs; run += 1) {
          const max = name === "openrouter" ? Math.min(MAX, job === "chat" ? 10 : 8) : MAX;
          try {
            const r = job === "chat" ? await chatJob(name, model, run, max) : job === "docs" ? await docsJob(name, model, run, max) : job === "vision" ? await visionJob(name, model, run) : await embedJob(name, model, run);
            saved.push({ ...r, tag: TAG, pace: PACE_ARG ?? PACE[name] ?? 2500, at: new Date().toISOString() });
            save();
            console.log(`${TAG ? `[${TAG}] ` : ""}${name} ${model} ${job} run ${run}: ${(r.accuracy * 100).toFixed(1)}% (${r.correct}/${r.n}) p95 ${r.tally.p95} ms, calls ${r.tally.calls}, failures ${r.tally.failures}${Object.keys(r.tally.errors ?? {}).length ? ` ${JSON.stringify(r.tally.errors)}` : ""}, 429 ${r.tally.rateLimited}, invalid JSON ${r.tally.invalidJson}, schema ${r.tally.schemaFail}${r.tally.billing ? ", BILLING: stopped" : ""}${r.note ? `, ${r.note}` : ""}`);
            if (r.tally.billing) break;
          } catch (error) {
            console.log(`${name} ${model} ${job} run ${run}: FAILED ${error instanceof Error ? error.message.slice(0, 160) : error}`);
            saved.push({ provider: name, model, job, run, n: 0, correct: 0, accuracy: 0, tally: { errors: { setup: 1 }, calls: 0, invalidJson: 0, schemaFail: 0, failures: 1, rateLimited: 0, billing: 0, inputTokens: 0, outputTokens: 0, headroom: null, p50: 0, p95: 0 }, note: `failed: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}` });
            save();
            break;
          }
        }
      }
    }
  }
  process.exit(0);
}

/* ------------------------------------------------------------------ rank (--rank): from all saved runs */

/**
 * Passes and conditions. Ranked: the normal pass ("" tag, production pacing and limits) and the --fewshot condition.
 * Reported, not ranked: slow / retry / slow-<fix> passes (throttling or adapter diagnostics), diag-* and pre-fix runs.
 */
const RANKED_TAGS = new Set(["", "fewshot"]);
type Agg = { tag: string; provider: string; model: string; job: string; runs: number; mean: number; min: number; max: number; spread: number; ci: [number, number] | null; p95: number; invalidRate: number; schemaRate: number; failures: number; r429: number; tokens: number; headroom: number | null; tier: string; n: number; bySet: Record<string, string>; note?: string };

const groups = new Map<string, JobResult[]>();
/** A run where more than half the calls were refused with 429 measured the free tier's quota, not the model. */
const quotaBound = (r: JobResult) => r.tally.calls > 0 && r.tally.rateLimited > r.tally.calls / 2;
const quotaRuns = saved.filter(quotaBound);
for (const r of saved) {
  if (r.tag === "pre-fix" || r.tag?.startsWith("diag")) continue; // before an adapter fix, or a diagnostic pass: reported, not ranked
  if (quotaBound(r)) continue; // listed under Quota-bound runs
  const k = `${r.job}|${r.provider}|${r.model}|${r.tag ?? ""}`;
  groups.set(k, [...(groups.get(k) ?? []), r]);
}
const aggs: Agg[] = [...groups.values()].map((all) => {
  // A run that failed before it started (setup error, refused batch) is a failure, not a 0% accuracy sample.
  const setupFailures = all.filter((r) => r.note?.startsWith("failed:")).length;
  const rs = all.filter((r) => !r.note?.startsWith("failed:")).length ? all.filter((r) => !r.note?.startsWith("failed:")) : all;
  const acc = rs.map((r) => r.accuracy);
  const calls = rs.reduce((a, r) => a + r.tally.calls, 0);
  const bySet: Record<string, string> = {};
  for (const r of rs) for (const [k, v] of Object.entries(r.bySet ?? {})) bySet[k] = `${(bySet[k] ? `${bySet[k]} / ` : "")}${v.correct}/${v.n}`;
  return {
    tag: rs[0].tag ?? "",
    provider: rs[0].provider,
    model: rs[0].model,
    job: rs[0].job,
    runs: rs.length,
    mean: acc.reduce((a, b) => a + b, 0) / acc.length,
    min: Math.min(...acc),
    max: Math.max(...acc),
    spread: Math.max(...acc) - Math.min(...acc),
    ci: rs.every((r) => r.items) ? bootstrapCi(rs.map((r) => r.items as number[])) : null,
    p95: Math.round(quantile(rs.map((r) => r.tally.p95), 0.5)),
    // Groq's HTTP 400 is json_validate_failed (checked 28 Oct); runs before that code was logged only saved "400".
    invalidRate: calls ? rs.reduce((a, r) => a + (r.provider === "groq" ? Math.max(r.tally.invalidJson, r.tally.errors?.["400"] ?? 0) : r.tally.invalidJson), 0) / calls : 0,
    schemaRate: calls ? rs.reduce((a, r) => a + r.tally.schemaFail, 0) / calls : 0,
    failures: rs.reduce((a, r) => a + r.tally.failures, 0) + (rs === all ? 0 : setupFailures),
    r429: rs.reduce((a, r) => a + r.tally.rateLimited, 0),
    tokens: rs.reduce((a, r) => a + r.tally.inputTokens + r.tally.outputTokens, 0),
    headroom: rs.map((r) => r.tally.headroom).filter((h): h is number => h !== null).pop() ?? null,
    tier: rs[0].provider === "hash" || rs[0].provider === "ollama" ? "local" : (providerSpecs()[rs[0].provider]?.tier ?? "?"),
    n: rs[0].n,
    bySet,
    note: rs.map((r) => r.note).filter(Boolean)[0],
  };
});

// A clean timing run (tag clean-latency: Ollama alone, nothing else on the machine) replaces the normal entry's p95.
for (const c of aggs.filter((x) => x.tag === "clean-latency")) {
  const normal = aggs.find((x) => x.tag === "" && x.provider === c.provider && x.model === c.model && x.job === c.job);
  if (normal) {
    normal.note = `${normal.note ? `${normal.note}; ` : ""}p95 from the clean-latency run (${c.p95} ms; with other jobs on the machine: ${normal.p95} ms)`;
    normal.p95 = c.p95;
  }
}
const label = (a: Agg) => `${a.provider}/${a.model}${a.tag ? ` [${a.tag}]` : ""}`;
const overlap = (a: Agg, b: Agg) => !a.ci || !b.ci || (a.ci[0] <= b.ci[1] && b.ci[0] <= a.ci[1]);
const TIER_RANK: Record<string, number> = { local: 0, A: 1, B: 2 };
/** Ollama qwen2.5:7b is the reference (today's behaviour): always listed and ranked, never dropped by a filter. */
const isReference = (a: Agg) => a.provider === "ollama" && a.model === "qwen2.5:7b" && a.tag === "";

/**
 * Same formula for every entry (docs/providers.md):
 * 1) hard filters: invalid JSON <= 2%, some correct answers; chat entries must have scored the same messages
 *    (equal n); the reference is never dropped (its filter failures are shown);
 * 2) accuracy: entries in mean order; an entry whose 95% bootstrap interval overlaps any entry already in the
 *    current group joins that group (tied); only non-overlapping intervals rank;
 * 3) inside a tie group: privacy tier (local, A, B), then p95 latency, then availability (failures + 429s).
 */
function rank(job: string) {
  const candidates = aggs.filter((a) => a.job === job && a.provider !== "hash" && RANKED_TAGS.has(a.tag));
  const fullN = Math.max(0, ...candidates.map((a) => a.n));
  const reasons = (a: Agg) => [a.invalidRate > 0.02 ? `invalid JSON ${(a.invalidRate * 100).toFixed(1)}%` : "", a.n === 0 || a.mean === 0 ? "no correct answers" : "", job === "chat" && a.n !== fullN ? `scored ${a.n} of ${fullN} messages` : ""].filter(Boolean);
  const eligible = candidates.filter((a) => isReference(a) || !reasons(a).length);
  const excluded = candidates.filter((a) => !eligible.includes(a)).map((a) => ({ entry: label(a), why: reasons(a).join("; ") }));
  const flagged = eligible.filter((a) => isReference(a) && reasons(a).length).map((a) => ({ entry: label(a), flags: reasons(a).join("; ") }));
  const byMean = [...eligible].sort((a, b) => b.mean - a.mean);
  const tieGroups: Agg[][] = [];
  for (const a of byMean) {
    const g = tieGroups[tieGroups.length - 1];
    if (g && g.some((b) => overlap(a, b))) g.push(a);
    else tieGroups.push([a]);
  }
  const within = (a: Agg, b: Agg) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9) || a.p95 - b.p95 || a.failures + a.r429 - (b.failures + b.r429);
  const order = tieGroups.flatMap((g, gi) => [...g].sort(within).map((a) => ({ group: gi + 1, entry: label(a), provider: a.provider, model: a.model, condition: a.tag || "normal", tier: a.tier, accuracy: Number(a.mean.toFixed(3)), ci95: a.ci?.map((x) => Number(x.toFixed(3))) ?? null, spread: Number(a.spread.toFixed(3)), p95: a.p95, availability: a.failures + a.r429 })));
  const ties = tieGroups.filter((g) => g.length > 1).map((g) => `${[...g].sort(within).map(label).join(" = ")} (tie broken by tier, then p95, then failures + 429s)`);
  return { order, ties, excluded, flagged, fullN };
}
const ranked = { chat: rank("chat"), docs: rank("docs"), vision: rank("vision"), embed: rank("embed") };

// The chains themselves are a decision (config/provider-order.json "chains"); --rank only rewrites the evidence.
const orderFile = join(root, "config/provider-order.json");
const current = existsSync(orderFile) ? (JSON.parse(readFileSync(orderFile, "utf8")) as Record<string, unknown>) : {};
writeFileSync(orderFile, `${JSON.stringify({ ...current, ranking: { generatedAt: new Date().toISOString(), source: `docs/baselines/providers-${DATE}.json`, chat: ranked.chat, docs: ranked.docs, vision: ranked.vision, embed: ranked.embed } }, null, 1)}\n`);

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const ciText = (a: Agg) => (a.ci ? `${pct(a.ci[0])}-${pct(a.ci[1])}` : "–");
const lines = [
  `# Provider benchmark ${DATE}`,
  "",
  "Raw: `providers-" + DATE + ".json`. English only. Accuracy = mean over runs; spread = max - min over runs; 95% CI = bootstrap over items (messages or expected dates, 2000 resamples, fixed seed). Masked text for every hosted provider. Ranked: normal pass and the few-shot condition; other passes are reported only.",
  "",
];
for (const job of ["chat", "docs", "vision", "embed"] as const) {
  lines.push(`## ${job}`, "", "| entry | tier | runs | n | accuracy (mean, min-max) | 95% CI | by set | p95 ms | invalid JSON | schema fail | failures | 429 | tokens | headroom |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const a of aggs.filter((x) => x.job === job).sort((x, y) => y.mean - x.mean)) lines.push(`| ${label(a)} | ${a.tier} | ${a.runs} | ${a.n} | ${pct(a.mean)} (${pct(a.min)}-${pct(a.max)}) | ${ciText(a)} | ${Object.entries(a.bySet).map(([k, v]) => `${k}: ${v}`).join("; ")} | ${a.p95} | ${pct(a.invalidRate)} | ${pct(a.schemaRate)} | ${a.failures} | ${a.r429} | ${a.tokens} | ${a.headroom ?? "–"} |${a.note ? ` ${a.note}` : ""}`);
  const r = ranked[job];
  lines.push("", "Ranking (group = entries whose intervals overlap: tied):", "", ...r.order.map((o, i) => `${i + 1}. [group ${o.group}] ${o.entry}: ${pct(o.accuracy)}${o.ci95 ? ` (CI ${pct(o.ci95[0])}-${pct(o.ci95[1])})` : ""}, tier ${o.tier}, p95 ${o.p95} ms`), "", `Ties: ${r.ties.join("; ") || "none"}`, `Reference flags: ${r.flagged.map((f) => `${f.entry}: ${f.flags}`).join("; ") || "none"}`, `Excluded: ${r.excluded.map((e) => `${e.entry} (${e.why})`).join("; ") || "none"}`, "");
}
// Paired comparisons (same messages): the two new conditions and each fallback against the reference.
const runsOf = (job: string, provider: string, model: string, tag: string) => saved.filter((r) => r.job === job && r.provider === provider && r.model === model && (r.tag ?? "") === tag && r.items && !quotaBound(r)).map((r) => r.items as number[]);
const pairs: Array<[string, [string, string, string], [string, string, string]]> = [
  ["14b vs 7b", ["ollama", "qwen2.5:14b", ""], ["ollama", "qwen2.5:7b", ""]],
  ["7b few-shot vs 7b", ["ollama", "qwen2.5:7b", "fewshot"], ["ollama", "qwen2.5:7b", ""]],
  ["GLM few-shot vs GLM", ["deploy", "zai-org/glm-5.3-flash", "fewshot"], ["deploy", "zai-org/glm-5.3-flash", ""]],
  ["Groq 20b few-shot vs Groq 20b", ["groq", "openai/gpt-oss-20b", "fewshot"], ["groq", "openai/gpt-oss-20b", ""]],
  ["Groq 20b vs Ollama 7b", ["groq", "openai/gpt-oss-20b", ""], ["ollama", "qwen2.5:7b", ""]],
  ["GLM vs Ollama 7b", ["deploy", "zai-org/glm-5.3-flash", ""], ["ollama", "qwen2.5:7b", ""]],
  ["GLM few-shot vs Ollama 7b", ["deploy", "zai-org/glm-5.3-flash", "fewshot"], ["ollama", "qwen2.5:7b", ""]],
  ["DeepSeek vs Ollama 7b", ["deploy", "deepseek-ai/deepseek-v4.1-flash-1017", ""], ["ollama", "qwen2.5:7b", ""]],
];
lines.push("## Paired comparisons (chat, same messages)", "", "Accuracy difference with a 95% paired bootstrap interval; an interval that excludes 0 is a real difference on this set.", "", "| comparison | difference | 95% CI | verdict |", "|---|---|---|---|");
for (const [name, a, b] of pairs) {
  const p = pairedDiffCi(runsOf("chat", ...a), runsOf("chat", ...b));
  lines.push(p ? `| ${name} | ${p.diff >= 0 ? "+" : ""}${(p.diff * 100).toFixed(1)} pts | ${(p.ci[0] * 100).toFixed(1)} to ${(p.ci[1] * 100).toFixed(1)} | ${p.ci[0] > 0 ? "better" : p.ci[1] < 0 ? "worse" : "no clear difference"} |` : `| ${name} | – | – | not measured (no unthrottled runs) |`);
}
lines.push("");
lines.push("## Quota-bound runs (not ranked)", "", "More than half the calls refused with HTTP 429 (free-tier tokens per minute or per day):", "", ...(quotaRuns.length ? quotaRuns.map((r) => `- ${r.provider}/${r.model}${r.tag ? ` [${r.tag}]` : ""} ${r.job} run ${r.run}: ${r.tally.rateLimited}/${r.tally.calls} calls 429`) : ["None."]), "");
writeFileSync(OUT.replace(/\.json$/, ".md"), lines.join("\n"));
console.log(lines.join("\n"));
process.exit(0);
