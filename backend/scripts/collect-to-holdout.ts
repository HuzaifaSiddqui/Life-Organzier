/**
 * `npm run collect -- path/to/collect-AB.md [more files…]`: turns filled copies of tests/eval/collect-sheet.md into
 * held-out rows.
 * - A message under a scenario with a command (S01–S12) is labelled by that scenario: it goes to
 *   tests/eval/chat-holdout.json (`commands`), id `c-<file>-<scenario>-<n>`, never into the bank.
 * - A message under S13 (no command), or one that can't be read, goes to tests/eval/review/collect-review.json with
 *   `command: ""`; a person labels it there. Those rows are never added to the bank or the held-out set by a script.
 * Repeated texts are skipped. Run `npm run eval:assistant` and `npm run eval:router` afterwards.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOLDOUT = join(root, "tests/eval/chat-holdout.json");
const REVIEW = join(root, "tests/eval/review/collect-review.json");

type Parsed = { scenario: string; command: string | null; lang: "en" | "ru"; text: string };

/** Messages from one filled sheet, with the scenario and language of the list they are in. */
export function parseSheet(md: string): Parsed[] {
  const out: Parsed[] = [];
  let scenario = "";
  let command: string | null = null;
  let lang: "en" | "ru" | null = null;
  for (const line of md.split(/\r?\n/)) {
    const tag = /<!--\s*scenario:\s*(\S+)\s+command:\s*(\S+)\s*-->/.exec(line);
    if (tag) {
      scenario = tag[1];
      command = tag[2] === "none" ? null : tag[2];
      lang = null;
      continue;
    }
    if (/^\*\*English\*\*/i.test(line.trim())) lang = "en";
    else if (/^\*\*Roman Urdu\*\*/i.test(line.trim())) lang = "ru";
    else if (/^##\s/.test(line)) lang = null;
    const m = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (m && scenario && lang) out.push({ scenario, command, lang, text: m[1] });
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

function main(): void {
  const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!files.length) {
    console.error("Usage: npm run collect -- collect-AB.md [collect-CD.md …]");
    process.exitCode = 1;
    return;
  }
  const holdout = JSON.parse(readFileSync(HOLDOUT, "utf8")) as { commands: Array<Record<string, unknown> & { text: string }> };
  const review = existsSync(REVIEW) ? (JSON.parse(readFileSync(REVIEW, "utf8")) as Array<Record<string, unknown> & { text: string }>) : [];
  const bank = JSON.parse(readFileSync(join(root, "tests/eval/utterance-bank.json"), "utf8")) as { rows: Array<{ text: string }> };
  const seen = new Set([...holdout.commands, ...review, ...bank.rows].map((r) => r.text.trim().toLowerCase()));
  let toHoldout = 0;
  let toReview = 0;
  let skipped = 0;
  for (const file of files) {
    const who = basename(file).replace(/\.md$/i, "").replace(/^collect-/i, "").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "x";
    const counter = new Map<string, number>();
    for (const p of parseSheet(readFileSync(file, "utf8"))) {
      const k = p.text.toLowerCase();
      if (seen.has(k)) {
        skipped += 1;
        continue;
      }
      seen.add(k);
      const n = (counter.get(p.scenario) ?? 0) + 1;
      counter.set(p.scenario, n);
      const id = `c-${who}-${p.scenario}-${n}`;
      if (p.command) {
        holdout.commands.push({ id, lang: p.lang, text: p.text, command: p.command });
        toHoldout += 1;
      } else {
        review.push({ id, lang: p.lang, text: p.text, scenario: p.scenario, command: "", approved: false });
        toReview += 1;
      }
    }
  }
  writeFileSync(HOLDOUT, `${JSON.stringify(holdout, null, 2)}\n`);
  mkdirSync(dirname(REVIEW), { recursive: true });
  writeFileSync(REVIEW, `${JSON.stringify(review, null, 1)}\n`);
  console.log(`${toHoldout} labelled rows → chat-holdout.json, ${toReview} unlabelled → review/collect-review.json, ${skipped} repeats skipped.`);
}
