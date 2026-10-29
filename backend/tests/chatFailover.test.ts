import assert from "node:assert/strict";
import test from "node:test";
import { HostedChains, setChains } from "../src/ai/chains.js";
import { AiService, ProviderHttpError, setAi, type ChatMessage, type CompletionOptions, type LlmProvider } from "../src/ai/llm.js";
import { COMMANDS, parseCtx } from "../src/modules/assistant/commands/registry.js";
import { routeWithLlm } from "../src/modules/assistant/commands/router.js";
import { NOW, TZ } from "./fixtures.js";

/**
 * The chat fallback chain end to end through the router (Step 4): Ollama → Deploy GLM (few-shot, masked) → Groq
 * gpt-oss-20b → rules, with fake providers. Each fake answers both router stages with one wrapped command.
 */
const cmd = COMMANDS.find((c) => c.wrapped)!;
const ctx = parseCtx({ now: NOW, tz: TZ });
type Behaviour = "ok" | "network" | "invalid" | "timeout" | "429";

function fake(name: string, behaviour: Behaviour) {
  const seen: ChatMessage[][] = [];
  const provider: LlmProvider = {
    name,
    chat: async () => {
      throw new Error(`${name}: the baseline path must not be used here`);
    },
    call: async (messages: ChatMessage[], options: CompletionOptions) => {
      seen.push(messages);
      if (behaviour === "network") throw new TypeError("fetch failed");
      if (behaviour === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      if (behaviour === "429") throw new ProviderHttpError(429, `${name} returned HTTP 429`);
      if (behaviour === "invalid") return { text: "Sure! It's a task." };
      const stage1 = Boolean((options.json as { properties?: Record<string, unknown> })?.properties?.category);
      return { text: JSON.stringify(stage1 ? { category: cmd.category } : { command: cmd.name, args: {} }) };
    },
  };
  return { provider, seen };
}

const ORDER = { chat: [{ provider: "ollama", model: "qwen2.5:7b" }, { provider: "deploy", model: "zai-org/glm-5.3-flash", fewShot: true }, { provider: "groq", model: "openai/gpt-oss-20b" }], docs: [], vision: [] };
const MESSAGE = "call Mooz at 0300-1234567 about the society budget";

async function route(env: Record<string, string>, behaviours: Record<"ollama" | "deploy" | "groq", Behaviour>) {
  const keep = { ...process.env };
  Object.assign(process.env, { LLM_LOG: "off", EMBEDDINGS_ENABLED: "false", LLM_PROVIDERS_CHAT: "ollama,deploy,groq", ...env });
  const fakes = { ollama: fake("ollama", behaviours.ollama), deploy: fake("deploy", behaviours.deploy), groq: fake("groq", behaviours.groq) };
  const baseline = fake("ollama-baseline", "ok");
  baseline.provider.chat = async (_m, options) => JSON.stringify((options.json as { properties?: Record<string, unknown> })?.properties?.category ? { category: cmd.category } : { command: cmd.name, args: {} });
  try {
    setChains(new HostedChains(ORDER, () => 1_800_000_000_000, (name) => fakes[name as keyof typeof fakes]?.provider ?? null));
    setAi(new AiService([baseline.provider]).allowHosted());
    const routed = await routeWithLlm(MESSAGE, ctx);
    return { routed, fakes, baseline };
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
    setChains(null);
    setAi(new AiService([]));
  }
}

const sent = (f: { seen: ChatMessage[][] }) => f.seen.map((m) => m.map((x) => x.content).join("\n"));

test("CLOUD_FALLBACK off (default): the chain is never used, even with LLM_PROVIDERS_CHAT set: the baseline path answers", async () => {
  const r = await route({}, { ollama: "ok", deploy: "ok", groq: "ok" });
  assert.equal(r.routed?.command, cmd.name);
  assert.equal(r.fakes.ollama.seen.length + r.fakes.deploy.seen.length + r.fakes.groq.seen.length, 0);
});

test("Ollama answers: nothing goes to the cloud", async () => {
  const r = await route({ CLOUD_FALLBACK: "on" }, { ollama: "ok", deploy: "ok", groq: "ok" });
  assert.equal(r.routed?.command, cmd.name);
  assert.equal(r.fakes.ollama.seen.length, 2, "both router stages");
  assert.equal(r.fakes.deploy.seen.length + r.fakes.groq.seen.length, 0);
});

test("Ollama down: Deploy GLM answers with few-shot examples and masked text; Ollama got neither", async () => {
  const r = await route({ CLOUD_FALLBACK: "on" }, { ollama: "network", deploy: "ok", groq: "ok" });
  assert.equal(r.routed?.command, cmd.name);
  assert.ok(sent(r.fakes.deploy).every((m) => /Similar messages/.test(m)), "few-shot for Deploy");
  assert.ok(sent(r.fakes.deploy).every((m) => !m.includes("0300-1234567") && !m.includes("Mooz")), "masked");
  assert.ok(sent(r.fakes.ollama).every((m) => !/Similar messages/.test(m) && m.includes("0300-1234567")), "Ollama: plain prompt, as written");
  assert.equal(r.fakes.groq.seen.length, 0);
});

test("invalid JSON from Ollama, timeout + 429 down the chain: the next provider answers; all failing → rules (null)", async () => {
  assert.equal((await route({ CLOUD_FALLBACK: "on" }, { ollama: "invalid", deploy: "ok", groq: "ok" })).routed?.command, cmd.name);
  const r = await route({ CLOUD_FALLBACK: "on" }, { ollama: "timeout", deploy: "429", groq: "ok" });
  assert.equal(r.routed?.command, cmd.name);
  assert.ok(r.fakes.groq.seen.length > 0 && sent(r.fakes.groq).every((m) => !/Similar messages/.test(m)), "Groq: no few-shot");
  assert.equal((await route({ CLOUD_FALLBACK: "on" }, { ollama: "network", deploy: "timeout", groq: "429" })).routed, null);
});
