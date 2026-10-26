/**
 * `npm run unknown:review`: turns backend/logs/unknown-utterances.jsonl (messages no command fitted) into review
 * rows in backend/logs/unknown-review.json, one per distinct message, with how often and when it was seen.
 * A reviewer fills `command` (and `args`) and sets `approved: true`; `npm run bank:approve` then moves approved rows
 * into tests/eval/utterance-bank.json. Both files stay in backend/logs (git-ignored): they hold real messages and
 * the repository is public. Re-running keeps the reviewer's edits.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG = join(root, "logs/unknown-utterances.jsonl");
const OUT = join(root, "logs/unknown-review.json");

type ReviewRow = { text: string; lang: string; seen: number; firstAt: string; lastAt: string; command: string; args: Record<string, unknown>; approved: boolean; note?: string };

const key = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

if (!existsSync(LOG)) {
  console.log(`No ${LOG} yet: nothing has been logged.`);
  process.exit(0);
}
const existing = new Map<string, ReviewRow>(existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")) as ReviewRow[]).map((r) => [key(r.text), r]) : []);
const counts = new Map<string, ReviewRow>();
for (const line of readFileSync(LOG, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const e = JSON.parse(line) as { text: string; lang: string; at: string };
  const k = key(e.text);
  const r = counts.get(k) ?? { text: e.text, lang: e.lang, seen: 0, firstAt: e.at, lastAt: e.at, command: "", args: {}, approved: false };
  r.seen += 1;
  if (e.at < r.firstAt) r.firstAt = e.at;
  if (e.at > r.lastAt) r.lastAt = e.at;
  counts.set(k, r);
}
const rows = [...counts.entries()].map(([k, r]) => {
  const old = existing.get(k);
  return old ? { ...r, command: old.command, args: old.args, approved: old.approved, ...(old.note ? { note: old.note } : {}) } : r;
});
rows.sort((a, b) => b.seen - a.seen || b.lastAt.localeCompare(a.lastAt));
writeFileSync(OUT, `${JSON.stringify(rows, null, 1)}\n`);
console.log(`${rows.length} distinct messages → ${OUT} (${rows.filter((r) => r.approved).length} approved). Fill command/args, set approved: true, then npm run bank:approve.`);
