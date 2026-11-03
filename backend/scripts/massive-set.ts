/**
 * MASSIVE (en-US test split) as an eval:routing set, from a local copy of the official release (never committed):
 *   npx tsx scripts/massive-set.ts --data <path>/1.1/data/en-US.jsonl --out <set.json> --checks <checks.json> [--sample 600 --seed 20261102]
 * Commands from tests/eval/massive/mapping.json (unmapped intents: "none"). --sample takes a fixed random sample,
 * stratified by intent (proportional, at least one per intent), with the seed written into the set.
 * Checks: "none" rows and safeOnly intents may change nothing; replyIncludes words must be in the reply.
 */
import { readFileSync, writeFileSync } from "node:fs";

const arg = (n: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined);
type Map = Record<string, { command: string; alsoOk?: string[]; safeOnly?: boolean; replyIncludes?: string[] }>;
const mapping = (JSON.parse(readFileSync(new URL("../tests/eval/massive/mapping.json", import.meta.url), "utf8")) as { intents: Map }).intents;
const rows = readFileSync(arg("data") as string, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; partition: string; intent: string; utt: string }).filter((r) => r.partition === "test");

// Seeded shuffle (mulberry32) so the sample is the same every time for the same seed.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let chosen = rows;
const size = Number(arg("sample") ?? 0);
const seed = Number(arg("seed") ?? 20261102);
if (size) {
  const rand = rng(seed);
  const byIntent = new globalThis.Map<string, typeof rows>();
  for (const r of rows) byIntent.set(r.intent, [...(byIntent.get(r.intent) ?? []), r]);
  chosen = [];
  for (const [, group] of [...byIntent].sort(([a], [b]) => a.localeCompare(b))) {
    const take = Math.max(1, Math.round((group.length / rows.length) * size));
    const shuffled = [...group].map((r) => ({ r, k: rand() })).sort((x, y) => x.k - y.k).map((x) => x.r);
    chosen.push(...shuffled.slice(0, take));
  }
}
const set = {
  description: `MASSIVE 1.1 en-US test split (Amazon, CC BY 4.0), ${chosen.length} rows${size ? `, stratified sample, seed ${seed}` : ""}. Local only; out-of-distribution stress test; never tuned on.`,
  now: "2026-10-05T05:00:00.000Z",
  timezone: "Asia/Karachi",
  commands: chosen.map((r) => ({ id: `m-${r.id}`, group: r.intent, text: r.utt, command: mapping[r.intent]?.command ?? "none", alsoOk: mapping[r.intent]?.alsoOk ?? [] })),
};
const checks = {
  description: "Checks for the MASSIVE set: 'none' rows and safeOnly intents may change nothing; replyIncludes words must be in the reply.",
  rows: chosen.flatMap((r) => {
    const m = mapping[r.intent];
    const c: Record<string, unknown> = { id: `m-${r.id}` };
    if (!m || m.safeOnly) c.db = [{ op: "none" }];
    if (m?.replyIncludes) c.mustInclude = m.replyIncludes;
    return Object.keys(c).length > 1 ? [c] : [];
  }),
};
writeFileSync(arg("out") as string, `${JSON.stringify(set, null, 1)}\n`);
writeFileSync(arg("checks") as string, `${JSON.stringify(checks, null, 1)}\n`);
console.log(`${set.commands.length} rows (${new Set(chosen.map((r) => r.intent)).size} intents) → ${arg("out")}; ${checks.rows.length} checks → ${arg("checks")}`);
