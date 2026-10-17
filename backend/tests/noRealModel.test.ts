import assert from "node:assert/strict";
import test from "node:test";
import { embedOne, HASH_EMBED_MODEL } from "../src/ai/embeddings.js";
import { AiService, getAi, setAi } from "../src/ai/llm.js";

/**
 * Unit tests must never reach a real model (they would depend on network, quota and model output).
 * tests/setup.ts switches AI off and blocks Gemini/Ollama hosts; this fails if either stops holding.
 */
test("tests never reach a real model: AI is off, the chain is empty and returns null without any request", async () => {
  assert.equal(process.env.AI_ENABLED, "false");
  assert.equal(process.env.GEMINI_API_KEY, "");

  const requests: string[] = [];
  const guarded = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    requests.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return guarded(input, init);
  }) as typeof fetch;
  try {
    setAi(null); // the shared service is built from the environment, as in the app
    const ai = getAi();
    assert.equal(ai.enabled, false);
    assert.equal(await ai.complete([{ role: "user", content: "Say hi" }]), null);
    assert.equal(await new AiService().complete([{ role: "user", content: "Say hi" }], { json: true }), null);
    assert.equal((await embedOne("study physics")).model, HASH_EMBED_MODEL); // hashed fallback, no Ollama call
  } finally {
    globalThis.fetch = guarded;
    setAi(null);
  }
  assert.deepEqual(requests, []);
});

test("the test fetch guard blocks Gemini and Ollama like Twilio and Expo", () => {
  assert.throws(() => fetch("https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=k"), /for real/);
  assert.throws(() => fetch("http://127.0.0.1:11434/api/chat"), /for real/);
  assert.throws(() => fetch("http://localhost:11434/api/embed"), /for real/);
  assert.throws(() => fetch("https://api.twilio.com/2010-04-01/Accounts/x/Messages.json"), /for real/);
});
