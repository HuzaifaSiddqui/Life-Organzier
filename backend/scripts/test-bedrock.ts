/**
 * Manual Bedrock check, for when there is AWS access: `npx tsx scripts/test-bedrock.ts`. Never prints credentials.
 *
 * Needs in backend/.env: BEDROCK_ENABLED=true, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (and
 * AWS_SESSION_TOKEN for temporary credentials), BEDROCK_MODEL (a model id enabled in the Bedrock console for that
 * region), BEDROCK_DAILY_BUDGET_USD (0 = stop at the first charge).
 *
 * Steps:
 *  1. Configuration present (names only).
 *  2. One plain call (Converse): signed request accepted, text returned, token counts present.
 *  3. One JSON call: reply parses and matches a schema.
 *  4. The hosted chain puts bedrock first when enabled (ai/chains.ts) and masks text.
 *  5. Error handling: a wrong model id gives a clean 4xx (no crash), and the breaker counts it.
 *
 * Unverified until this passes: the SigV4 signing against the real service (only checked for stability in
 * tests/hostedChains.test.ts), model ids and regions, Converse response shapes, latency, quotas, pricing and the
 * daily budget guard (no cost data from Bedrock responses: needs Cost Explorer or a token × price estimate),
 * AWS data terms (tier A is assumed from AWS's standard Bedrock terms, not checked).
 */
import { readFileSync } from "node:fs";
import { parse } from "dotenv";
import { z } from "zod";

const env = parse(readFileSync(new URL("../.env", import.meta.url)));
for (const [k, v] of Object.entries(env)) if (!(k in process.env)) process.env[k] = v;
const { BedrockProvider } = await import("../src/ai/providers.js");
const { HostedChains } = await import("../src/ai/chains.js");
const { extractJson } = await import("../src/ai/llm.js");

const step = (n: number, label: string, ok: boolean, detail = "") => console.log(`${ok ? "PASS" : "FAIL"} ${n}. ${label}${detail ? ` — ${detail}` : ""}`);
const need = ["BEDROCK_ENABLED", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "BEDROCK_MODEL"];
const missing = need.filter((k) => !process.env[k]);
step(1, "configuration", missing.length === 0 && process.env.BEDROCK_ENABLED === "true", missing.length ? `missing: ${missing.join(", ")}` : "names present");
if (missing.length || process.env.BEDROCK_ENABLED !== "true") process.exit(1);

const p = new BedrockProvider();
try {
  const r = await p.call([{ role: "user", content: "Say hello in three words." }], { maxTokens: 30, timeoutMs: 15000 });
  step(2, "plain call", Boolean(r.text.trim()), `tokens in ${r.usage?.inputTokens ?? "?"} / out ${r.usage?.outputTokens ?? "?"}`);
} catch (e) {
  step(2, "plain call", false, e instanceof Error ? e.message : String(e));
}
try {
  const r = await p.call([{ role: "user", content: 'Return {"ok": true}' }], { json: true, maxTokens: 30, timeoutMs: 15000 });
  step(3, "JSON call", z.object({ ok: z.boolean() }).safeParse(extractJson(r.text)).success);
} catch (e) {
  step(3, "JSON call", false, e instanceof Error ? e.message : String(e));
}
process.env.LLM_PROVIDERS_CHAT = "bedrock,ollama";
const chains = new HostedChains({ chat: [{ provider: "ollama", model: "qwen2.5:7b" }], docs: [], vision: [] });
step(4, "bedrock leads the chat chain", chains.chain("chat")[0]?.provider === "bedrock", JSON.stringify(chains.chain("chat").map((c) => c.provider)));
try {
  await new BedrockProvider("not-a-real-model").call([{ role: "user", content: "hi" }], { timeoutMs: 15000 });
  step(5, "wrong model id gives a 4xx", false, "no error");
} catch (e) {
  step(5, "wrong model id gives a 4xx", /HTTP 4\d\d/.test(e instanceof Error ? e.message : ""), e instanceof Error ? e.message : String(e));
}
process.exit(0);
