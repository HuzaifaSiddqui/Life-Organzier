/**
 * Blank manifest for your private documents: `npm run docs:manifest-template` (add `-- --force` to replace an existing
 * one). Lists every file in tests/eval/documents/private/ with empty fields; nothing is read from the documents or the
 * pipeline. Fill it in, then score: `npm run eval:documents -- --private [--ai]` (report: private/results.md). The
 * folder is git-ignored: the files, the manifest and the results never leave this machine.
 */
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../tests/eval/documents/private");
const out = join(dir, "manifest.json");
const SUPPORTED = new Set([".pdf", ".docx", ".png", ".jpg", ".jpeg", ".txt"]);
if (!existsSync(dir)) throw new Error(`No folder ${dir}: put your documents there first.`);
if (existsSync(out) && !process.argv.includes("--force")) throw new Error(`${out} exists; run with -- --force to replace it (your filled entries would be lost).`);
const files = readdirSync(dir).filter((f) => !f.startsWith(".") && !/^(manifest|results)/.test(f) && statSync(join(dir, f)).isFile()).sort();
const docs = files.filter((f) => SUPPORTED.has(extname(f).toLowerCase()));
const skipped = files.filter((f) => !SUPPORTED.has(extname(f).toLowerCase()));
const template = {
 help: {
  now: "The date the documents are read as (ISO, e.g. 2026-10-29T05:00:00.000Z): the year of dates written without one, and what counts as past, come from it.",
  docType: "SYLLABUS | SCHEDULE | NOTES | OTHER (what you would pick in the app).",
  language: "eng (empty = eng), or urd / ara / … for OCR.",
  expectedDeadlines: "Items that SHOULD be created. title: the distinctive words (every word of 3+ letters must appear in the extracted title, any order, case ignored; a 5+ letter word may be one letter off). date: YYYY-MM-DD, exact. time: optional (e.g. 4 PM or 16:00), compared as a clock time; empty = any time. kind: optional (exam, assignment, quiz, event, payment, travel…), reported, not scored.",
  expectedSchedules: "Classes for timetables. title as above; days: 0=Sun … 6=Sat, exact set; time: the start time; room: optional, exact (case ignored).",
  shouldNotCreate: "Dates in the document that are NOT deadlines (a printed date, a holiday, a past date…). date: YYYY-MM-DD; title: optional words to narrow it; reason: a few words. An extracted item that matches is reported, and is a wrong auto-create if it would be created automatically.",
  blankRows: "A row whose title and date (or days) are empty is ignored, so leave the blank example rows or delete them.",
  scoring: "Per document and overall: recall = expected items found with the right date (and time / days / room when given); precision = extracted items that match an expected item; wrong items reaching auto-create must stay 0.",
 },
 now: "",
 timezone: "Asia/Karachi",
 documents: docs.map((file) => ({
  file,
  docType: "",
  language: "",
  expectedDeadlines: [{ title: "", date: "", time: "", kind: "" }],
  expectedSchedules: [{ title: "", days: [], time: "", room: "" }],
  shouldNotCreate: [{ date: "", title: "", reason: "" }],
 })),
 notSupported: skipped.map((file) => ({ file, reason: "not a supported upload type (PDF, DOCX, JPG, PNG, TXT)" })),
};
writeFileSync(out, `${JSON.stringify(template, null, 1)}\n`);
console.log(`Wrote ${out}: ${docs.length} documents${skipped.length ? `, ${skipped.length} not supported (listed under notSupported)` : ""}.`);
