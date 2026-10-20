/**
 * Document extraction evaluation: `npm run eval:documents`.
 *   --private        your own documents in tests/eval/documents/private/ (gitignored; results stay in that folder)
 *   --ai             let the model run too (default: AI off, the rules and OCR only)
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
const { analyzeDocument } = await import("../src/modules/documents/documentProcessing.js");
const { shutdownOcr } = await import("../src/modules/documents/textExtraction.js");

type ExpDeadline = { titleContains: string; date: string | null; time?: string };
type ExpSchedule = { titleContains: string; days: number[]; time: string; room?: string };
type Doc = { file: string; docType: "SYLLABUS" | "SCHEDULE" | "NOTES" | "OTHER"; language?: string; categories?: string[]; from?: string; expectedDeadlines?: ExpDeadline[]; expectedSchedules?: ExpSchedule[] };
type Manifest = { now: string; timezone: string; documents: Doc[] };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isPrivate = flags.has("--private");
const dir = join(root, "tests/eval/documents", isPrivate ? "private" : "");
if (!existsSync(join(dir, "manifest.json"))) {
  console.log(`No manifest at ${join(dir, "manifest.json")}. Copy tests/eval/documents/manifest.json's format (see tests/eval/documents/README.md).`);
  process.exit(0);
}
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
const now = new Date(manifest.now ?? Date.now());
const tz = manifest.timezone ?? "Asia/Karachi";
const MIME: Record<string, string> = { ".txt": "text/plain", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };

const lower = (s: string | null | undefined) => (s ?? "").toLowerCase();
const sameDays = (a: number[], b: number[]) => [...new Set(a)].sort().join() === [...new Set(b)].sort().join();

type Row = { file: string; categories: string[]; expected: number; found: number; extracted: number; correct: number; ocr: number; method: string; failures: string[]; ms: number };
const rows: Row[] = [];

for (const doc of manifest.documents) {
  if (flags.has("--text-only") && doc.from) continue;
  const source = doc.from ? manifest.documents.find((d) => d.file === `fixtures/${doc.from}.txt`) : doc;
  const expD = source?.expectedDeadlines ?? [];
  const expS = source?.expectedSchedules ?? [];
  const started = Date.now();
  const a = await analyzeDocument({
    buffer: readFileSync(join(dir, doc.file)),
    fileName: doc.file,
    mimeType: MIME[extname(doc.file).toLowerCase()] ?? "application/octet-stream",
    docType: doc.docType,
    language: doc.language ?? "eng",
    tz,
    now,
  });
  const failures: string[] = [];
  let found = 0;
  let correct = 0;

  // Deadlines: one extracted item per expected item.
  const used = new Set<number>();
  for (const e of expD) {
    const titled = a.deadlines.filter((d, i) => !used.has(i) && lower(d.title).includes(lower(e.titleContains)));
    const hit = titled.find((d) => d.date === e.date && (!e.time || d.time === e.time));
    if (hit) {
      used.add(a.deadlines.indexOf(hit));
      found += 1;
      correct += 1;
      continue;
    }
    const near = titled.find((d) => d.date === e.date) ?? titled[0];
    failures.push(
      !near
        ? `missed deadline "${e.titleContains || "(any)"}" ${e.date ?? "(undated)"}${e.time ? ` ${e.time}` : ""}`
        : near.date !== e.date
          ? `wrong date for "${e.titleContains || near.title}": got ${near.date ?? "none"}, expected ${e.date ?? "none"}`
          : `wrong time for "${e.titleContains || near.title}": got ${near.time ?? "none"}, expected ${e.time}`,
    );
  }
  a.deadlines.forEach((d, i) => {
    if (!used.has(i)) failures.push(`extra deadline "${d.title}" ${d.date ?? "(undated)"}${d.time ? ` ${d.time}` : ""}`);
  });

  // Schedules: rows with the same title and time are combined (a class on Mon and Wed may be two rows).
  const usedS = new Set<number>();
  for (const e of expS) {
    const group = a.schedules.map((s, i) => ({ s, i })).filter(({ s }) => lower(s.title).includes(lower(e.titleContains)) && s.time === e.time);
    const days = group.flatMap(({ s }) => s.daysOfWeek);
    const roomOk = !e.room || group.some(({ s }) => lower(s.room) === lower(e.room));
    if (group.length && sameDays(days, e.days) && roomOk) {
      found += 1;
      group.forEach(({ i }) => usedS.add(i));
      correct += group.length;
      continue;
    }
    const titled = a.schedules.filter((s) => lower(s.title).includes(lower(e.titleContains)));
    failures.push(
      !titled.length
        ? `missed class "${e.titleContains}" ${e.days.join(",")} ${e.time}`
        : `wrong class "${e.titleContains}": got ${titled.map((s) => `${s.daysOfWeek.join(",")} ${s.time ?? "?"}${s.room ? ` ${s.room}` : ""}`).join(" + ")}, expected ${e.days.join(",")} ${e.time}${e.room ? ` ${e.room}` : ""}`,
    );
  }
  a.schedules.forEach((s, i) => {
    if (!usedS.has(i)) failures.push(`extra class "${s.title}" ${s.daysOfWeek.join(",")} ${s.time ?? ""}`);
  });

  rows.push({ file: doc.file, categories: doc.categories ?? [], expected: expD.length + expS.length, found, extracted: a.deadlines.length + a.schedules.length, correct, ocr: a.ocrConfidence, method: a.method, failures, ms: Date.now() - started });
}
await shutdownOcr();

/* ------------------------------------------------------------------ report */

type Score = { expected: number; found: number; extracted: number; correct: number };
const sum = (rs: Row[]): Score => rs.reduce((s, r) => ({ expected: s.expected + r.expected, found: s.found + r.found, extracted: s.extracted + r.extracted, correct: s.correct + r.correct }), { expected: 0, found: 0, extracted: 0, correct: 0 });
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
const recall = (s: Score) => pct(s.found, s.expected);
const precision = (s: Score) => pct(s.correct, s.extracted);

const text = rows.filter((r) => !r.file.startsWith("images/"));
const images = rows.filter((r) => r.file.startsWith("images/"));
const all = sum(rows);
const categories = [...new Set(rows.flatMap((r) => r.categories))].sort();
const baselinePath = join(root, "tests/eval/documents/baseline.json");
type Baseline = Record<string, { recall: string; precision: string }>;
const baseline: Baseline | null = !isPrivate && existsSync(baselinePath) ? (JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline) : null;

const summary: Array<[string, Score]> = [["All", all], ["Text fixtures", sum(text)], ["Image fixtures (OCR)", sum(images)], ...categories.map((c) => [c, sum(rows.filter((r) => r.categories.includes(c)))] as [string, Score])];
const md: string[] = [
  "# Document extraction evaluation",
  "",
  isPrivate ? "Private documents (not committed)." : "Synthetic fixtures in `backend/tests/eval/documents/` (no personal data). Generated by `npm run eval:documents`; do not edit by hand.",
  "",
  `Run: ${new Date().toISOString().slice(0, 10)}, AI ${flags.has("--ai") ? "on" : "off"}, ${rows.length} documents, document date ${manifest.now} (${tz}).`,
  "",
  `| Set | Expected | Found | Recall | Extracted | Precision |${baseline ? " Baseline recall | Baseline precision |" : ""}`,
  `|---|---|---|---|---|---|${baseline ? "---|---|" : ""}`,
  ...summary.map(([name, s]) => `| ${name} | ${s.expected} | ${s.found} | ${recall(s)} | ${s.extracted} | ${precision(s)} |${baseline ? ` ${baseline[name]?.recall ?? "–"} | ${baseline[name]?.precision ?? "–"} |` : ""}`),
  "",
  "## Per document",
  "",
  "| Document | Found / expected | Extracted (correct) | OCR conf. | Method | Time |",
  "|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.file} | ${r.found}/${r.expected} | ${r.extracted} (${r.correct}) | ${r.ocr} | ${r.method} | ${(r.ms / 1000).toFixed(1)} s |`),
  "",
  "## Failures by category",
  "",
];
for (const c of categories) {
  const fails = rows.filter((r) => r.categories.includes(c) && r.failures.length);
  if (!fails.length) continue;
  md.push(`### ${c}`, "");
  for (const r of fails) md.push(`- **${r.file}**: ${r.failures.join("; ")}`);
  md.push("");
}

const out = isPrivate ? join(dir, "results.md") : join(root, "../docs/document-eval-results.md");
writeFileSync(out, `${md.join("\n").trimEnd()}\n`);
if (flags.has("--save-baseline") && !isPrivate) {
  writeFileSync(baselinePath, `${JSON.stringify(Object.fromEntries(summary.map(([n, s]) => [n, { recall: recall(s), precision: precision(s) }])), null, 2)}\n`);
}

console.log(`\nRecall ${recall(all)} (${all.found}/${all.expected}), precision ${precision(all)} (${all.correct}/${all.extracted}) over ${rows.length} documents.`);
for (const [name, s] of summary.slice(1)) console.log(`  ${name.padEnd(22)} recall ${recall(s).padStart(6)}  precision ${precision(s).padStart(6)}`);
const failing = rows.filter((r) => r.failures.length);
if (failing.length) console.log(`\nFailures:\n${failing.map((r) => `  ${r.file}\n    ${r.failures.join("\n    ")}`).join("\n")}`);
console.log(`\nReport: ${out}`);
process.exit(0);
