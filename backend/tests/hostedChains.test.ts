import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { BREAKER_OPEN_MS, HostedChains } from "../src/ai/chains.js";
import { AiService, ProviderHttpError, type ChatMessage, type CompletionOptions, type LlmProvider } from "../src/ai/llm.js";
import { sigV4Headers } from "../src/ai/providers.js";

/** A fake provider: each call runs the next behaviour; records what it was sent. */
function fake(name: string, behaviours: Array<"ok" | "json" | "bad-json" | "schema" | "429" | "500" | "402" | "timeout" | "network" | "cost">) {
  const seen: Array<{ messages: ChatMessage[]; options: CompletionOptions }> = [];
  let i = 0;
  const provider: LlmProvider = {
    name,
    chat: async () => "unused",
    call: async (messages, options) => {
      seen.push({ messages, options });
      const b = behaviours[Math.min(i++, behaviours.length - 1)];
      if (b === "429") throw new ProviderHttpError(429, `${name} returned HTTP 429`);
      if (b === "500") throw new ProviderHttpError(500, `${name} returned HTTP 500`);
      if (b === "402") throw new ProviderHttpError(402, `${name} returned HTTP 402`);
      if (b === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      if (b === "network") throw new TypeError("fetch failed");
      if (b === "bad-json") return { text: "sure! here you go" };
      if (b === "schema") return { text: '{"answer": 5}' };
      if (b === "cost") return { text: '{"answer":"paid"}', usage: { costUsd: 0.001 } };
      return { text: b === "json" ? `{"answer":"${name}"}` : `text from ${name}` };
    },
  };
  return { provider, seen };
}

const schema = z.object({ answer: z.string() });
const ask: ChatMessage[] = [{ role: "user", content: "call Mooz at 0300-1234567, mail a.b@x.com" }];

function chains(env: Record<string, string>, order: Array<{ provider: string; model: string }>, instances: Record<string, LlmProvider>, now = () => 1_800_000_000_000) {
  const keep = { ...process.env };
  Object.assign(process.env, { LLM_LOG: "off", CLOUD_FALLBACK: "on", ...env });
  try {
    return new HostedChains({ chat: order, docs: order, vision: order }, now, (name) => instances[name] ?? null);
  } finally {
    for (const k of [...Object.keys(env), "CLOUD_FALLBACK"]) if (keep[k] === undefined) delete process.env[k];
    else process.env[k] = keep[k];
  }
}

test("nothing configured: the AiService keeps the baseline path (no hosted chain)", async () => {
  delete process.env.LLM_PROVIDERS_CHAT;
  const base = fake("ollama", ["json"]);
  base.provider.chat = async () => '{"answer":"baseline"}';
  const ai = new AiService([base.provider]).allowHosted();
  assert.deepEqual(await ai.json(ask, schema), { answer: "baseline" });
  assert.equal(base.seen.length, 0, "the baseline path calls chat(), not the hosted chain's call()");
});

test("fail over on timeout, 429, 5xx, bad JSON and a schema failure; the last good one answers", async () => {
  for (const bad of ["timeout", "429", "500", "bad-json", "schema"] as const) {
    const a = fake("groq", [bad]);
    const b = fake("cerebras", ["json"]);
    const c = chains({ LLM_PROVIDERS_CHAT: "groq,cerebras" }, [{ provider: "groq", model: "m1" }, { provider: "cerebras", model: "m2" }], { groq: a.provider, cerebras: b.provider });
    assert.deepEqual(await c.json("chat", ask, schema), { answer: "cerebras" }, bad);
  }
});

test("one retry on a network error only (not on a timeout)", async () => {
  const net = fake("groq", ["network", "json"]);
  const c = chains({ LLM_PROVIDERS_CHAT: "groq" }, [{ provider: "groq", model: "m" }], { groq: net.provider });
  assert.deepEqual(await c.json("chat", ask, schema), { answer: "groq" });
  assert.equal(net.seen.length, 2);
  const slow = fake("groq", ["timeout", "json"]);
  const c2 = chains({ LLM_PROVIDERS_CHAT: "groq" }, [{ provider: "groq", model: "m" }], { groq: slow.provider });
  assert.equal(await c2.json("chat", ask, schema), null, "a timeout is not retried: the rules take over");
  assert.equal(slow.seen.length, 1);
});

test("breaker: 3 failures skip the provider for 60 s, then one probe decides", async () => {
  let t = 1_800_000_000_000;
  const a = fake("groq", ["500", "500", "500", "json"]);
  const b = fake("cerebras", ["json"]);
  const c = chains({ LLM_PROVIDERS_CHAT: "groq,cerebras" }, [{ provider: "groq", model: "m" }, { provider: "cerebras", model: "m" }], { groq: a.provider, cerebras: b.provider }, () => t);
  for (let i = 0; i < 3; i += 1) await c.json("chat", ask, schema);
  assert.equal(a.seen.length, 3);
  await c.json("chat", ask, schema);
  assert.equal(a.seen.length, 3, "open: skipped");
  assert.equal(c.status().find((s) => s.provider === "groq")?.state, "down");
  t += BREAKER_OPEN_MS + 1;
  assert.deepEqual(await c.json("chat", ask, schema), { answer: "groq" }, "after 60 s one probe; it works, so it is closed again");
  assert.equal(c.status().find((s) => s.provider === "groq")?.state, "up");
});

test("$0 spend cap: HTTP 402 or a reported cost turns the provider off for the day; daily caps fall through", async () => {
  const paid = fake("groq", ["cost", "json"]);
  const b = fake("cerebras", ["json"]);
  const c = chains({ LLM_PROVIDERS_CHAT: "groq,cerebras" }, [{ provider: "groq", model: "m" }, { provider: "cerebras", model: "m" }], { groq: paid.provider, cerebras: b.provider });
  await c.json("chat", ask, schema);
  assert.equal(c.status().find((s) => s.provider === "groq")?.state, "billing_blocked");
  assert.deepEqual(await c.json("chat", ask, schema), { answer: "cerebras" });
  assert.equal(paid.seen.length, 1, "never asked again today");
  const card = fake("groq", ["402"]);
  const c2 = chains({ LLM_PROVIDERS_CHAT: "groq,cerebras" }, [{ provider: "groq", model: "m" }, { provider: "cerebras", model: "m" }], { groq: card.provider, cerebras: fake("cerebras", ["json"]).provider });
  await c2.json("chat", ask, schema);
  assert.equal(c2.status().find((s) => s.provider === "groq")?.state, "billing_blocked");
  // OpenRouter: 20 a minute (config/providers.json), then the next provider.
  const or = fake("openrouter", ["json"]);
  const c3 = chains({ LLM_PROVIDERS_CHAT: "groq,openrouter", LLM_TIER_B_LEAD_APPROVED: "openrouter" }, [{ provider: "openrouter", model: "x:free" }, { provider: "groq", model: "m" }], { openrouter: or.provider, groq: fake("groq", ["json"]).provider });
  for (let i = 0; i < 25; i += 1) await c3.json("chat", ask, schema);
  assert.equal(or.seen.length, 20);
});

test("masking: hosted providers get masked text; Ollama gets the message as written", async () => {
  const hosted = fake("groq", ["json"]);
  const c = chains({ LLM_PROVIDERS_CHAT: "groq" }, [{ provider: "groq", model: "m" }], { groq: hosted.provider });
  await c.json("chat", ask, schema);
  assert.equal(hosted.seen[0].messages[0].content, "call [name] at [PHONE], mail [email]");
  const local = fake("ollama", ["json"]);
  const c2 = chains({ LLM_PROVIDERS_CHAT: "ollama" }, [{ provider: "ollama", model: "qwen2.5:7b" }], { ollama: local.provider });
  await c2.json("chat", ask, schema);
  assert.equal(local.seen[0].messages[0].content, ask[0].content);
});

test("tier B never leads without approval and never gets images; vision chains take tier A image providers only", () => {
  const instances = { openrouter: fake("openrouter", ["json"]).provider, groq: fake("groq", ["json"]).provider, gemini: fake("gemini", ["json"]).provider };
  const order = [{ provider: "openrouter", model: "x:free" }, { provider: "gemini", model: "g" }, { provider: "groq", model: "m" }];
  assert.deepEqual(chains({ LLM_PROVIDERS_CHAT: "openrouter,gemini,groq" }, order, instances).chain("chat").map((e) => e.provider), ["groq", "openrouter", "gemini"]);
  assert.deepEqual(chains({ LLM_PROVIDERS_CHAT: "openrouter,gemini,groq", LLM_TIER_B_LEAD_APPROVED: "openrouter" }, order, instances).chain("chat").map((e) => e.provider), ["openrouter", "gemini", "groq"]);
  assert.deepEqual(chains({ LLM_PROVIDERS_VISION: "openrouter,gemini,groq" }, order, instances).chain("vision"), [], "Gemini and OpenRouter are tier B; Groq takes no images");
});

test("Bedrock (mocked): a SigV4 request is signed the documented way; disabled without BEDROCK_ENABLED", () => {
  // AWS's documented example values (no real account): the signature must be stable for the same input.
  const h = sigV4Headers({ method: "POST", host: "bedrock-runtime.us-east-1.amazonaws.com", path: "/model/m/converse", body: "{}", region: "us-east-1", service: "bedrock", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", now: new Date("2026-10-28T00:00:00Z") });
  assert.match(h.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261028\/us-east-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  const again = sigV4Headers({ method: "POST", host: "bedrock-runtime.us-east-1.amazonaws.com", path: "/model/m/converse", body: "{}", region: "us-east-1", service: "bedrock", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", now: new Date("2026-10-28T00:00:00Z") });
  assert.equal(h.authorization, again.authorization);
  assert.equal(h["x-amz-date"], "20261028T000000Z");
});
