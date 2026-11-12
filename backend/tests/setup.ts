/**
 * Runs before every test file (npm test: --import ./tests/setup.ts).
 *
 * - Tests use TEST_DATABASE_URL, never the development database. Before this, Prisma Client loaded
 *   backend/.env by itself, so tests wrote to whatever DATABASE_URL pointed at (the dev database).
 *   npm test refuses to run without TEST_DATABASE_URL, or if its database name doesn't contain "test".
 * - No real WhatsApp messages or pushes: Twilio and Expo credentials are blanked (and api.whatsapp.com, the WhatsApp
 *   Agent API, is never called: its tests use tests/fakes/fakeAgentServer.ts) (blank, not deleted, so
 *   Prisma's own .env loading can't fill them back in), any request to their hosts throws, and pushes go
 *   to a fake provider.
 * - Every feature flag starts at its default (FEATURE_FLAGS below): Prisma Client loads the backend/.env next to its
 *   node_modules by itself, so a developer's flags (CHAT_FIXES_V2=on, …) used to leak in and fail tests written for
 *   the defaults. A test that needs a flag sets it and puts it back.
 * - No real model: AI is switched off (AI_ENABLED=false, as in CI) and GEMINI_API_KEY is blanked, so the
 *   provider chain is empty and replies come from the rules. Requests to Gemini or Ollama throw too. A test
 *   that needs a model injects a fake one with setAi(new AiService([...])).
 * Scripts that are meant to use the real model (scripts/e2e-conversation.ts, scripts/model-benchmark.ts)
 * load .env themselves and never run this file.
 */
import { existsSync, readFileSync } from "node:fs";
import { isMainThread } from "node:worker_threads";
import { parse } from "dotenv";

const envFile = new URL("../.env", import.meta.url);
const fromFile = existsSync(envFile) ? parse(readFileSync(envFile)) : {};

const testUrl = process.env.TEST_DATABASE_URL || fromFile.TEST_DATABASE_URL;
if (!testUrl) {
  throw new Error("TEST_DATABASE_URL is not set. Add a separate test database to backend/.env (see .env.example), then run `npm run test:db`.");
}
const dbName = new URL(testUrl).pathname.replace(/^\//, "");
if (!/test/i.test(dbName)) {
  throw new Error(`TEST_DATABASE_URL must point at a test database (its name must contain "test"); got "${dbName}". Refusing to run tests.`);
}
process.env.DATABASE_URL = testUrl;

for (const key of new Set([...Object.keys(process.env), ...Object.keys(fromFile)])) {
  if (/^(?:TWILIO_|EXPO_)/.test(key)) process.env[key] = "";
}
/**
 * Feature flags every test starts with at their default (blanked below). A test that needs one sets it
 * itself and puts it back. Blank, not deleted: Prisma Client loads the .env next to its own node_modules when it
 * starts, and fills in variables that are missing, so a developer's .env (flags on) would leak into the suite.
 * Blank means the default for both kinds: `=== "on"` flags are off, `!== "off"` flags (WhatsApp Agent) stay on.
 */
export const FEATURE_FLAGS = [
  "CALENDAR_SYNC",
  "CHAT_FIXES_V2",
  "CLOUD_FALLBACK",
  "COLLAB_TASKS",
  "DOC_AGREE",
  "DOC_AI_SPLIT",
  "DOC_DATESHEET",
  "DOC_EVIDENCE",
  "DOC_EVIDENCE_V2",
  "DOC_FALLBACK_UI",
  "DOC_INSTRUCTIONS",
  "DOC_LAYOUT",
  "DOC_PRIORITY_V2",
  "DOC_ROUTING",
  "MEANING_ROUTER",
  "OOS_CONFIRM",
  "OOS_NOTE",
  "GEMINI_FALLBACK",
  "BEDROCK_ENABLED",
  "WHATSAPP_AGENT",
  "WHATSAPP_AGENT_REMINDERS",
  "WHATSAPP_VOICE",
] as const;

/** On/off settings in .env.example that are not feature flags (set below where needed). */
export const NOT_FLAGS = ["AI_ENABLED", "EMBEDDINGS_ENABLED", "DISABLE_JOBS", "LLM_LOG", "UNKNOWN_LOG", "SMTP_SECURE"] as const;

// Every feature flag at its default (blank, so Prisma's own .env loading can't fill a developer's "on" back in).
for (const flag of FEATURE_FLAGS) process.env[flag] = "";
process.env.AI_ENABLED = "false";
// No real speech-to-text (the default is a local whisper.cpp server); a voice test installs a fake with setStt().
process.env.STT_PROVIDER = "none";
// Unknown messages are not logged to backend/logs from tests (a test that checks the log sets its own path).
process.env.UNKNOWN_LOG_PATH = "off";
process.env.GEMINI_API_KEY = "";

/** Where Ollama would be reached (same default as ai/llm.ts). */
const ollamaBase = (process.env.OLLAMA_URL || fromFile.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const ollamaHosts = new Set([new URL(ollamaBase).host, "127.0.0.1:11434", "localhost:11434"]);

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = /^https?:\/\//i.test(url) ? new URL(url).host : "";
  if (/^https?:\/\/(?:[\w-]+\.)*(?:twilio\.com|exp\.host|expo\.dev|generativelanguage\.googleapis\.com|whatsapp\.com)(?:[:/]|$)/i.test(url) || ollamaHosts.has(host)) {
    throw new Error(`A test tried to call ${new URL(url).host} for real.`);
  }
  return realFetch(input, init);
}) as typeof fetch;

// Pushes go to a fake provider unless a test installs its own (setPushProvider); Expo is never called.
// Worker threads (Tesseract OCR) inherit --import but run no app code, so they skip this.
if (isMainThread) {
  const { setPushProvider } = await import("../src/modules/push/pushService.js");
  setPushProvider({
    send: async (messages) => messages.map((_, i) => ({ id: `test-ticket-${Date.now()}-${i}` })),
    receipts: async () => ({}),
  });
}
