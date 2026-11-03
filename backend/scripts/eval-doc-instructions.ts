/**
 * DOC_INSTRUCTIONS evaluation on synthetic multi-teacher documents (tests/eval/doc-instructions; made-up names):
 *   npx tsx scripts/eval-doc-instructions.ts [--ai off|local]
 * Per instruction: LEAK RATE (items shown that the instruction excludes; must be 0), recall of the requested items,
 * the question asked when a name is ambiguous or missing, and, with no instruction, items equal to the flag off.
 * --ai local: the rules plus the local model (Ollama) when the rules are unsure; never a hosted provider.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gridImage } from "./docInstructionGrid.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined);
const AI = arg("ai") ?? "off";
Object.assign(process.env, { CLOUD_FALLBACK: "off", LLM_LOG: "off", GEMINI_API_KEY: "", ...(AI === "off" ? { AI_ENABLED: "false" } : { AI_ENABLED: "true" }) });

const { AiService, OllamaProvider, setAi } = await import("../src/ai/llm.js");
const { analyzeDocument, withInstruction } = await import("../src/modules/documents/documentProcessing.js");
const { shutdownOcr } = await import("../src/modules/documents/textExtraction.js");
setAi(AI === "off" ? new AiService([]) : new AiService([new OllamaProvider()]));

const dir = join(root, "tests/eval/doc-instructions");
type Case = { instruction: string; expect?: string[]; status?: string; options?: string[]; offStatus?: string };
const spec = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8")) as { documents: Array<{ file: string; shape: string; cases: Case[] }> };
const NOW = new Date("2026-10-05T05:00:00Z");
const TZ = "Asia/Karachi";

const strip = (items: unknown[]) => JSON.stringify(items.map((i) => { const { meta: _m, filteredOut: _f, ...rest } = i as Record<string, unknown>; return rest; }));
let leaks = 0;
let shownTotal = 0;
let wanted = 0;
let found = 0;
let questions = 0;
let questionsRight = 0;
let baselineSame = 0;
const rows: string[] = [];
for (const doc of spec.documents) {
  const input = doc.file === "grid"
    ? { buffer: await gridImage(), fileName: "grid.png", mimeType: "image/png" }
    : { text: readFileSync(join(dir, doc.file), "utf8"), fileName: doc.file, mimeType: "text/plain" };
  const base = { ...input, docType: "SCHEDULE" as const, language: "eng", tz: TZ, now: NOW };
  // No instruction: the flag must not change what is extracted.
  process.env.DOC_INSTRUCTIONS = "off";
  const off = await analyzeDocument(base);
  process.env.DOC_INSTRUCTIONS = "on";
  const a = await analyzeDocument(base);
  const same = strip(off.deadlines) === strip(a.deadlines) && strip(off.schedules) === strip(a.schedules);
  baselineSame += same ? 1 : 0;
  rows.push(`\n${doc.file} (${doc.shape}): ${a.deadlines.length} deadlines, ${a.schedules.length} classes; no instruction = flag off: ${same ? "yes" : "NO"}`);
  for (const c of doc.cases) {
    const extracted = { deadlines: structuredClone(a.deadlines), schedules: structuredClone(a.schedules) } as Parameters<typeof withInstruction>[1];
    const x = await withInstruction(a.text, extracted, c.instruction, null, "2026-10-05");
    const r = x.instruction!;
    const items = [...x.deadlines, ...x.schedules];
    if (c.offStatus && AI === "off" && r.status !== "applied") {
      // AI off: the rules couldn't place every word; they must ask (saying what they understood), never guess.
      questions += 1;
      const ok = r.status === c.offStatus;
      questionsRight += ok ? 1 : 0;
      rows.push(`  ${ok ? "ok  " : "FAIL"} "${c.instruction}" → ${r.status} (understood: ${r.understood.join(", ") || "nothing"}; not placed: ${(r.leftover ?? []).join(", ")})`);
      continue;
    }
    if (c.status) {
      questions += 1;
      const optionsOk = !c.options || (c.options.length === (r.options ?? []).length && c.options.every((o) => (r.options ?? []).some((p) => p.includes(o))));
      const ok = r.status === c.status && optionsOk;
      questionsRight += ok ? 1 : 0;
      rows.push(`  ${ok ? "ok  " : "FAIL"} "${c.instruction}" → ${r.status}${r.options ? ` [${r.options.join(" | ")}]` : ""}${r.nearest ? ` nearest [${r.nearest.join(" | ")}]` : ""} (expected ${c.status})`);
      continue;
    }
    const shown = r.status === "applied" ? items.filter((i) => !i.filteredOut) : [];
    const expected = items.filter((i) => (c.expect ?? []).some((e) => i.title.includes(e)));
    const leaked = shown.filter((i) => !(c.expect ?? []).some((e) => i.title.includes(e)));
    const hit = expected.filter((i) => shown.includes(i));
    leaks += leaked.length;
    shownTotal += shown.length;
    wanted += expected.length;
    found += hit.length;
    rows.push(`  ${leaked.length === 0 && hit.length === expected.length ? "ok  " : "FAIL"} "${c.instruction}" → ${r.status}: ${shown.length} shown of ${items.length}, ${hit.length}/${expected.length} wanted${leaked.length ? `, LEAKED: ${leaked.map((i) => i.title).join("; ")}` : ""}${r.status !== "applied" ? ` (${(r.leftover ?? r.options ?? r.nearest ?? []).join(", ")})` : ""}`);
  }
}
await shutdownOcr();
console.log(rows.join("\n"));
console.log(`\nAI ${AI}: LEAK RATE ${leaks}/${shownTotal} items shown (${shownTotal ? ((100 * leaks) / shownTotal).toFixed(1) : "0.0"}%); recall ${found}/${wanted}; questions right ${questionsRight}/${questions}; no instruction = flag off on ${baselineSame}/${spec.documents.length} documents`);
process.exit(0);
