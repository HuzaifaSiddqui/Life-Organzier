/**
 * Time per chat message through the real engine (handleAssistantMessage): `npx tsx scripts/bench-latency.ts`
 * (AI off) or `-- --ai` (the providers in backend/.env, as the server runs them). `--max 40` messages, an even
 * sample of the English and Roman Urdu rows of tests/eval/utterance-bank.json, each from a fresh user on the TEST
 * database (TEST_DATABASE_URL; its name must contain "test"), clock pinned. `--unsure`: only the rows the rules are
 * not sure about (confidence below 0.75, no command rule), the ones that reach the model with AI on; an even sample
 * mostly times the rules. Prints and writes JSON with the median and p95 in ms and how many took over 1 s. Used for
 * the baseline and the gate (docs/baselines, docs/rollout.md).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parse } from "dotenv";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = parse(readFileSync(join(root, ".env")));
const ai = process.argv.includes("--ai");
const arg = (name: string, d: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) || d : d;
};
const max = arg("max", 40);
const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;
const testUrl = process.env.TEST_DATABASE_URL || env.TEST_DATABASE_URL;
if (!testUrl || !/test/i.test(new URL(testUrl).pathname)) throw new Error("TEST_DATABASE_URL must point at a test database");
// The test database only; the model settings from .env (or none) — never Twilio, Expo or push.
for (const [k, v] of Object.entries(env)) if (!(k in process.env) && !/^(?:TWILIO_|EXPO_|DATABASE_URL)/.test(k)) process.env[k] = v;
process.env.DATABASE_URL = testUrl;
process.env.UNKNOWN_LOG = "off";
if (!ai) {
  process.env.AI_ENABLED = "false";
  process.env.GEMINI_API_KEY = "";
}

const { prisma } = await import("../src/config/db.js");
await import("../src/modules/assistant/commands/registry.js");
const { handleAssistantMessage } = await import("../src/modules/assistant/dialogue.js");
const { matchCommand, parseCtx } = await import("../src/modules/assistant/commands/registry.js");
const { parseMulti } = await import("../src/modules/assistant/commands/multi.js");
const { rulesUnderstand } = await import("../src/modules/assistant/nlu.js");

type Row = { id: string; text: string; lang: string };
const now = new Date("2026-10-05T05:00:00.000Z");
const opts = { now, tz: "Asia/Karachi" };
const unsure = (text: string) => !parseMulti(text, parseCtx(opts)) && !matchCommand(text, parseCtx(opts)) && rulesUnderstand(text, opts).confidence < 0.75;
const bank = (JSON.parse(readFileSync(join(root, "tests/eval/utterance-bank.json"), "utf8")) as { rows: Row[] }).rows
  .filter((r) => r.lang === "en" || r.lang === "ru")
  .filter((r) => !process.argv.includes("--unsure") || unsure(r.text));
const step = Math.max(1, Math.floor(bank.length / max));
const sample = bank.filter((_, i) => i % step === 0).slice(0, max);
const times: number[] = [];
let failed = 0;
for (const row of sample) {
  const user = await prisma.user.create({ data: { firebaseUid: `bench-${randomUUID()}`, email: `bench-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: "Asia/Karachi", tier: "PRO" } });
  const t0 = performance.now();
  try {
    await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, text: row.text, channel: "APP", now });
  } catch {
    failed += 1;
  }
  times.push(performance.now() - t0);
  await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
}
const sorted = [...times].sort((a, b) => a - b);
const q = (p: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]);
const result = { ai, unsure: process.argv.includes("--unsure"), messages: sample.length, failed, over1s: times.filter((t) => t > 1000).length, medianMs: q(0.5), p95Ms: q(0.95), maxMs: Math.round(sorted[sorted.length - 1]) };
console.log(JSON.stringify(result));
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
}
await prisma.$disconnect();
process.exit(0);
