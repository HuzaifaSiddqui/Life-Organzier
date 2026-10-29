import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "dotenv";
import { OpenAiCompatibleProvider, GeminiModelProvider, providerSpecs } from "../src/ai/providers.js";

/**
 * One real call per provider that has a key: `LLM_SMOKE=1 npm test -- tests/providerSmoke.test.ts` (or run this file).
 * Skipped otherwise (CI has no keys; tests never call real providers by default). Never prints keys.
 */
const on = process.env.LLM_SMOKE === "1";
const env = on ? parse(readFileSync(new URL("../.env", import.meta.url))) : {};
const config = JSON.parse(readFileSync(new URL("../config/provider-candidates.json", import.meta.url), "utf8")) as { candidates: Record<string, { chat?: string[] }> };
const ask = [{ role: "user" as const, content: 'Reply with JSON {"ok": true} and nothing else.' }];

for (const [name, spec] of Object.entries(providerSpecs())) {
  if (spec.kind !== "openai" && spec.kind !== "gemini") continue;
  const keys = spec.keyEnv.map((k) => env[k]).filter(Boolean);
  const model = config.candidates[name]?.chat?.[0];
  keys.forEach((key, i) => {
    test(`smoke: ${name}${keys.length > 1 ? ` key ${i + 1}` : ""} (${model ?? "no model"})`, { skip: !on ? "LLM_SMOKE not set" : !model ? "no candidate model" : false }, async () => {
      const p = spec.kind === "gemini" ? new GeminiModelProvider(model as string, key) : new OpenAiCompatibleProvider(name, model as string, spec.baseUrl as string, key, spec.extraBody);
      const r = await p.call(ask, { json: true, maxTokens: 40, timeoutMs: 15000 });
      assert.match(r.text, /ok/i);
      assert.ok(!r.usage?.costUsd, "no cost ($0 cap)");
    });
  });
}
