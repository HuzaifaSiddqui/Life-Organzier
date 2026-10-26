/**
 * `npm run bank:approve`: moves rows marked `approved: true` (with a command) from the review files into
 * tests/eval/utterance-bank.json, and removes them from the review file. Nothing else ever adds to the bank.
 * Review files: backend/logs/unknown-review.json (real messages, git-ignored) and
 * tests/eval/review/paraphrases-review.json (model paraphrases). The command must be a registry command or an nlu
 * intent already used in the bank. Rows from chat-holdout.json are refused.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.AI_ENABLED = "false";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BANK = join(root, "tests/eval/utterance-bank.json");
const REVIEWS = [
  { file: join(root, "logs/unknown-review.json"), source: "unknown-log", prefix: "u" },
  { file: join(root, "tests/eval/review/paraphrases-review.json"), source: "paraphrase", prefix: "p" },
];
const { getCommand } = await import("../src/modules/assistant/commands/registry.js");

type Review = { text: string; lang: string; command: string; args?: Record<string, unknown>; approved: boolean };
const bank = JSON.parse(readFileSync(BANK, "utf8")) as { rows: Array<{ id: string; text: string; lang: string; command: string; args?: Record<string, unknown>; source: string }> };
const known = new Set(bank.rows.map((r) => r.command));
const holdout = new Set(
  (JSON.parse(readFileSync(join(root, "tests/eval/chat-holdout.json"), "utf8")) as { commands: Array<{ text: string }> }).commands.map((r) => r.text.trim().toLowerCase()),
);
const inBank = new Set(bank.rows.map((r) => r.text.trim().toLowerCase()));
let added = 0;
for (const { file, source, prefix } of REVIEWS) {
  if (!existsSync(file)) continue;
  const rows = JSON.parse(readFileSync(file, "utf8")) as Review[];
  const keep: Review[] = [];
  for (const r of rows) {
    const k = r.text.trim().toLowerCase();
    const ok = r.approved && r.command && (getCommand(r.command) || known.has(r.command)) && ["en", "ru", "ur"].includes(r.lang);
    if (!ok) {
      if (r.approved) console.warn(`  skipped (unknown command or language): "${r.text}" → ${r.command}`);
      keep.push(r);
      continue;
    }
    if (holdout.has(k)) {
      console.warn(`  refused (in chat-holdout.json): "${r.text}"`);
      continue;
    }
    if (!inBank.has(k)) {
      bank.rows.push({ id: `${prefix}${String(bank.rows.filter((x) => x.source === source).length + 1).padStart(3, "0")}`, text: r.text, lang: r.lang, command: r.command, ...(r.args && Object.keys(r.args).length ? { args: r.args } : {}), source });
      inBank.add(k);
      added += 1;
    }
  }
  writeFileSync(file, `${JSON.stringify(keep, null, 1)}\n`);
}
writeFileSync(BANK, `${JSON.stringify(bank, null, 1)}\n`);
console.log(`${added} approved rows added to the bank (${bank.rows.length} rows). Re-run npm run eval:router.`);
process.exit(0);
