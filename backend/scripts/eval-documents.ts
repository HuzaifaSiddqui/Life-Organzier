/**
 * Document extraction evaluation: `npm run eval:documents`.
 *   --private        your own documents in tests/eval/documents/private/ (gitignored; results stay in that folder)
 *   --ai             also run every fixture with the model on, reported in its own section (default: rules and
 *                    OCR only; CI has no model). Needs Ollama or Gemini configured as for the server.
 *   --text-only      skip the image (OCR) fixtures
 *   --save-baseline  store this run as the baseline the report compares against
 * Recall = expected items found with the right date (and time / days / room when given).
 * Precision = extracted items that match an expected item (wrong dates and extra items count against it).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const flags = new Set(process.argv.slice(2));
if (!flags.has("--ai")) {
  process.env.AI_ENABLED = "false";
  process.env.GEMINI_API_KEY = "";
}
const { analyzeDocument, DEADLINE_AUTO, SCHEDULE_AUTO } = await import("../src/modules/documents/documentProcessing.js");
const { AiService, setAi } = await import("../src/ai/llm.js");
const { shutdownOcr } = await import("../src/modules/documents/textExtraction.js");
const { timeMatches, titleMatches } = await import("./docMatch.js");

/**
 * Expected items. Synthetic fixtures use `titleContains` (exact case-insensitive substring) and an exact `time`.
 * The private manifest (npm run docs:manifest-template) uses `title` (word match, scripts/docMatch.ts), `time` compared
 * as a clock time, and `kind` (reported, not scored); an entry whose title and date are both empty is a blank
 * template row and is skipped. `shouldNotCreate`: dates in the document that are not deadlines; an extracted item on
 * that date (and with that title, when one is given) is reported, and counts as a wrong auto-create if it would be
 * created automatically.
 */
type ExpDeadline = { titleContains?: string; title?: string; date: string | null; time?: string; kind?: string };
type ExpSchedule = { titleContains?: string; title?: string; days: number[]; time: string; room?: string };
type NotItem = { date: string; title?: string; reason?: string };
type Doc = { file: string; docType: "SYLLABUS" | "SCHEDULE" | "NOTES" | "OTHER" | ""; language?: string; categories?: string[]; from?: string; expectedDeadlines?: ExpDeadline[]; expectedSchedules?: ExpSchedule[]; shouldNotCreate?: NotItem[] };
type Manifest = { now: string; timezone: string; documents: Doc[] };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isPrivate = flags.has("--private");
const dir = join(root, "tests/eval/documents", isPrivate ? "private" : "");
if (!existsSync(join(dir, "manifest.json"))) {
  console.log(`No manifest at ${join(dir, "manifest.json")}. Copy tests/eval/documents/manifest.json's format (see tests/eval/documents/README.md).`);
  process.exit(0);
}
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
if (isPrivate && !manifest.now) {
  console.log("Fill \"now\" in the private manifest first (the date the documents are read as).");
  process.exit(0);
}
const now = new Date(manifest.now ?? Date.now());
const tz = manifest.timezone ?? "Asia/Karachi";
const MIME: Record<string, string> = { ".txt": "text/plain", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };

const lower = (s: string | null | undefined) => (s ?? "").toLowerCase();
const named = (e: { titleContains?: string; title?: string }) => e.title ?? e.titleContains ?? "";
const titleOk = (e: { titleContains?: string; title?: string }, got: string) => (e.title !== undefined ? titleMatches(e.title, got) : lower(got).includes(lower(e.titleContains)));
const timeOk = (e: { title?: string; time?: string }, got: string | null) => (e.title !== undefined ? timeMatches(e.time, got) : !e.time || got === e.time);
const filled = (e: { titleContains?: string; title?: string; date?: string | null; days?: number[] }) => Boolean(named(e).trim() || e.date || e.days?.length);
const sameDays = (a: number[], b: number[]) => [...new Set(a)].sort().join() === [...new Set(b)].sort().join();

type Row = { file: string; categories: string[]; expected: number; found: number; extracted: number; correct: number; ocr: number; method: string; failures: string[]; ms: number; wrongAuto: number; notCreated: number };

async function evaluate(): Promise<Row[]> {
  const rows: Row[] = [];
  for (const doc of manifest.documents) {
    if (flags.has("--text-only") && doc.from) continue;
    if (!doc.docType) {
      console.log(`skipped ${isPrivate ? "a private document" : doc.file}: no docType yet (fill the manifest)`);
      continue;
    }
    const source = doc.from ? manifest.documents.find((d) => d.file === `fixtures/${doc.from}.txt`) : doc;
    const expD = (source?.expectedDeadlines ?? []).filter(filled);
    const expS = (source?.expectedSchedules ?? []).filter(filled);
    const nots = (source?.shouldNotCreate ?? []).filter((n) => n.date);
    const started = Date.now();
    const a = await analyzeDocument({
      buffer: readFileSync(join(dir, doc.file)),
      fileName: doc.file,
      mimeType: MIME[extname(doc.file).toLowerCase()] ?? "application/octet-stream",
      docType: doc.docType,
      language: doc.language || "eng",
      tz,
      now,
    });
    const failures: string[] = [];
    let found = 0;
    let correct = 0;

    // Deadlines: one extracted item per expected item.
    const used = new Set<number>();
    for (const e of expD) {
      const titled = a.deadlines.filter((d, i) => !used.has(i) && titleOk(e, d.title));
      const hit = titled.find((d) => d.date === e.date && timeOk(e, d.time));
      if (hit) {
        used.add(a.deadlines.indexOf(hit));
        found += 1;
        correct += 1;
        continue;
      }
      const near = titled.find((d) => d.date === e.date) ?? titled[0];
      failures.push(
        !near
          ? `missed deadline "${named(e) || "(any)"}" ${e.date ?? "(undated)"}${e.time ? ` ${e.time}` : ""}`
          : near.date !== e.date
            ? `wrong date for "${named(e) || near.title}": got ${near.date ?? "none"}, expected ${e.date ?? "none"}`
            : `wrong time for "${named(e) || near.title}": got ${near.time ?? "none"}, expected ${e.time}`,
      );
    }
    // Wrong items that auto-create would have created (same rule as processDocument): must stay 0.
    const autoOk = a.ocrConfidence >= 70 && !a.needsLanguage;
    let wrongAuto = 0;
    let notCreated = 0;
    a.deadlines.forEach((d, i) => {
      if (used.has(i)) return;
      const not = nots.find((n) => n.date === d.date && (!n.title || titleMatches(n.title, d.title)));
      if (not) notCreated += 1;
      failures.push(`${not ? `should-not item ("${not.reason ?? "not a deadline"}")` : "extra deadline"} "${d.title}" ${d.date ?? "(undated)"}${d.time ? ` ${d.time}` : ""}`);
      if (autoOk && d.date && d.confidence >= DEADLINE_AUTO) wrongAuto += 1;
    });

    // Schedules: rows with the same title and time are combined (a class on Mon and Wed may be two rows).
    const usedS = new Set<number>();
    for (const e of expS) {
      const group = a.schedules.map((s, i) => ({ s, i })).filter(({ s }) => titleOk(e, s.title) && (e.title !== undefined ? timeMatches(e.time, s.time) : s.time === e.time));
      const days = group.flatMap(({ s }) => s.daysOfWeek);
      const roomOk = !e.room || group.some(({ s }) => lower(s.room) === lower(e.room));
      if (group.length && sameDays(days, e.days) && roomOk) {
        found += 1;
        group.forEach(({ i }) => usedS.add(i));
        correct += group.length;
        continue;
      }
      const titled = a.schedules.filter((s) => titleOk(e, s.title));
      failures.push(
        !titled.length
          ? `missed class "${named(e)}" ${e.days.join(",")} ${e.time}`
          : `wrong class "${named(e)}": got ${titled.map((s) => `${s.daysOfWeek.join(",")} ${s.time ?? "?"}${s.room ? ` ${s.room}` : ""}`).join(" + ")}, expected ${e.days.join(",")} ${e.time}${e.room ? ` ${e.room}` : ""}`,
      );
    }
    a.schedules.forEach((s, i) => {
      if (usedS.has(i)) return;
      failures.push(`extra class "${s.title}" ${s.daysOfWeek.join(",")} ${s.time ?? ""}`);
      if (autoOk && a.schedules.length <= 5 && s.daysOfWeek.length && s.confidence >= SCHEDULE_AUTO) wrongAuto += 1;
    });

    rows.push({ file: doc.file, categories: doc.categories ?? [], expected: expD.length + expS.length, found, extracted: a.deadlines.length + a.schedules.length, correct, ocr: a.ocrConfidence, method: a.method, failures, ms: Date.now() - started, wrongAuto, notCreated });
  }
  return rows;
}

// Rules only (AI off) always; with --ai the same fixtures again with the model on.
setAi(new AiService([]));
const rulesRows = await evaluate();
let aiRows: Row[] | null = null;
if (flags.has("--ai")) {
  setAi(null); // the configured providers, as the server uses them
  aiRows = await evaluate();
}
await shutdownOcr();

/* ------------------------------------------------------------------ report */

type Score = { expected: number; found: number; extracted: number; correct: number };
const sum = (rs: Row[]): Score => rs.reduce((s, r) => ({ expected: s.expected + r.expected, found: s.found + r.found, extracted: s.extracted + r.extracted, correct: s.correct + r.correct }), { expected: 0, found: 0, extracted: 0, correct: 0 });
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
const recall = (s: Score) => pct(s.found, s.expected);
const precision = (s: Score) => pct(s.correct, s.extracted);

const baselinePath = join(root, "tests/eval/documents/baseline.json");
type Baseline = Record<string, { recall: string; precision: string }>;
const baseline: Baseline | null = !isPrivate && existsSync(baselinePath) ? (JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline) : null;

function summaryOf(rows: Row[]): Array<[string, Score]> {
  const categories = [...new Set(rows.flatMap((r) => r.categories))].sort();
  return [
    ["All", sum(rows)],
    ["Text fixtures", sum(rows.filter((r) => !r.file.startsWith("images/")))],
    ["Image fixtures (OCR)", sum(rows.filter((r) => r.file.startsWith("images/")))],
    ...categories.map((c) => [c, sum(rows.filter((r) => r.categories.includes(c)))] as [string, Score]),
  ];
}

function section(title: string, rows: Row[], compare: Baseline | null): string[] {
  const summary = summaryOf(rows);
  const md = [
    `## ${title}`,
    "",
    `| Set | Expected | Found | Recall | Extracted | Precision |${compare ? " Baseline recall | Baseline precision |" : ""}`,
    `|---|---|---|---|---|---|${compare ? "---|---|" : ""}`,
    ...summary.map(([name, s]) => `| ${name} | ${s.expected} | ${s.found} | ${recall(s)} | ${s.extracted} | ${precision(s)} |${compare ? ` ${compare[name]?.recall ?? "–"} | ${compare[name]?.precision ?? "–"} |` : ""}`),
    "",
    `Wrong items reaching auto-create (confidence at or above the auto-create gate, not matching any expected item): **${rows.reduce((n, r) => n + r.wrongAuto, 0)}** (must stay 0).`,
    "",
    "### Per document",
    "",
    "| Document | Found / expected | Recall | Extracted (correct) | Precision | Wrong auto-create | Should-not items | OCR conf. | Method | Time |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.file} | ${r.found}/${r.expected} | ${pct(r.found, r.expected)} | ${r.extracted} (${r.correct}) | ${pct(r.correct, r.extracted)} | ${r.wrongAuto} | ${r.notCreated} | ${r.ocr} | ${r.method} | ${(r.ms / 1000).toFixed(1)} s |`),
    "",
    "### Failures by category",
    "",
  ];
  const categories = [...new Set(rows.flatMap((r) => r.categories))].sort();
  let any = false;
  for (const c of categories) {
    const fails = rows.filter((r) => r.categories.includes(c) && r.failures.length);
    if (!fails.length) continue;
    any = true;
    md.push(`#### ${c}`, "");
    for (const r of fails) md.push(`- **${r.file}**: ${r.failures.join("; ")}`);
    md.push("");
  }
  if (!any) md.push("None.", "");
  return md;
}

const md: string[] = [
  "# Document extraction evaluation",
  "",
  isPrivate
    ? "Private documents (not committed)."
    : "Synthetic fixtures in `backend/tests/eval/documents/` (no personal data). Generated by `npm run eval:documents`; do not edit by hand.",
  "",
  ...(isPrivate
    ? []
    : [
        "**Read these numbers as a regression suite, not an accuracy estimate.** The fixtures were written together with the rules (each one targets a failure mode the rules were then built to handle), so a high score shows the rules still do what they were made for. Real accuracy has to be measured on documents nobody tuned against (`npm run eval:documents -- --private`).",
        "",
        aiRows
          ? "The model was on for the second section (`--ai`)."
          : "**The AI pass and its merge with the rules are not covered here**: this run had AI off (CI has no model). Run `npm run eval:documents -- --ai` with a model configured to add that section.",
        "",
      ]),
  `Run: ${new Date().toISOString().slice(0, 10)}, ${rulesRows.length} documents, document date ${manifest.now} (${tz}).`,
  "",
  ...section("Rules only (AI off)", rulesRows, baseline),
  ...(aiRows ? section("With the model (AI on)", aiRows, null) : []),
];

const out = isPrivate ? join(dir, "results.md") : join(root, "../docs/document-eval-results.md");
writeFileSync(out, `${md.join("\n").trimEnd()}\n`);
if (flags.has("--save-baseline") && !isPrivate) {
  writeFileSync(baselinePath, `${JSON.stringify(Object.fromEntries(summaryOf(rulesRows).map(([n, s]) => [n, { recall: recall(s), precision: precision(s) }])), null, 2)}\n`);
}

function print(title: string, rows: Row[]): void {
  const summary = summaryOf(rows);
  const all = summary[0][1];
  console.log(`\n${title}: recall ${recall(all)} (${all.found}/${all.expected}), precision ${precision(all)} (${all.correct}/${all.extracted}) over ${rows.length} documents.`);
  console.log(`  wrong items reaching auto-create: ${rows.reduce((n, r) => n + r.wrongAuto, 0)}`);
  for (const [name, s] of summary.slice(1)) console.log(`  ${name.padEnd(22)} recall ${recall(s).padStart(6)}  precision ${precision(s).padStart(6)}`);
  const failing = rows.filter((r) => r.failures.length);
  if (failing.length) console.log(`Failures:\n${failing.map((r) => `  ${r.file}\n    ${r.failures.join("\n    ")}`).join("\n")}`);
}
print("Rules only (AI off)", rulesRows);
if (aiRows) print("With the model (AI on)", aiRows);
console.log(`\nReport: ${out}`);
process.exit(0);
