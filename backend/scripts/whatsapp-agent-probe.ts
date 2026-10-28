/**
 * WhatsApp Agent probe. Records, redacted, what the real API returns, and tests the one thing still unconfirmed:
 * whether the agent may message first (needed for "WhatsApp only" reminders).
 *
 *   cd backend
 *   (PowerShell) $env:WHATSAPP_AGENT_API_KEY = "<key>"; npm run wa:probe -- listen
 *   later, after 30+ quiet minutes:                      npm run wa:probe -- proactive --quiet 30
 *
 * Privacy: the key is never printed (scrubbed from every error). Message text, names, numbers and ids are never
 * printed or saved: only field names, value types and an allowlist of non-personal facts (MIME type, size,
 * duration, the first 4 bytes of a media file as hex, status codes, timings). The sender reference needed for
 * step 4 is kept in backend/.probe/state.json (git-ignored, never printed).
 *
 * Rate limits: at most 12 polls a minute (limit 15), one send every 10 s (limit 12). A 429 stops the probe at
 * once; it never tries to hit a limit. Stop the Life Organizer server first if it uses the same key (409).
 */
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { normalizeMessage, rawMessages, shape } from "../src/modules/whatsappAgent/shapes.js";

const KEY = process.env.WHATSAPP_AGENT_API_KEY ?? "";
const BASE = (process.env.WHATSAPP_AGENT_BASE_URL ?? "https://api.whatsapp.com/agent/v1").replace(/\/$/, "");
const DIR = new URL("../.probe/", import.meta.url);
const STATE = new URL("state.json", DIR);
const MIN_POLL_GAP_MS = 5000;
const MIN_SEND_GAP_MS = 10000;
const LISTEN_LIMIT_MS = 12 * 60000;

type Json = unknown;
const findings: Array<Record<string, unknown>> = [];
const scrub = (t: string) => (KEY ? t.split(KEY).join("[key]") : t);
const log = (line: string) => console.log(scrub(line));
const record = (step: string, data: Record<string, unknown>) => findings.push({ step, at: new Date().toISOString(), ...data });

/** Non-personal facts kept as values: MIME types, sizes, durations, message types, booleans like voice. */
export function allowedFacts(value: Json, path = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, Json>)) allowedFacts(v, path ? `${path}.${k}` : k, out);
    return out;
  }
  const key = path.split(".").pop() ?? "";
  if (/mime|content_?type/i.test(key) && typeof value === "string" && /^[\w.+-]+\/[\w.+-]+(;.*)?$/.test(value)) out[path] = value;
  else if (/(size|bytes|duration|seconds)$/i.test(key) && typeof value === "number") out[path] = value;
  else if (/^(type|field|object|voice|status)$/i.test(key) && (typeof value === "boolean" || (typeof value === "string" && /^[a-z_]{1,24}$/i.test(value)))) out[path] = value;
  return out;
}

class HttpFail extends Error {
  constructor(readonly status: number, readonly body: Json, readonly retryAfter: string | null) {
    super(`HTTP ${status}`);
  }
}
const codesOf = (body: Json) => {
  const e = body && typeof body === "object" ? ((body as Record<string, Json>).error as Record<string, Json> | undefined) : undefined;
  return { code: typeof e?.code === "number" ? e.code : null, subcode: typeof e?.error_subcode === "number" ? e.error_subcode : null, type: typeof e?.type === "string" ? e.type : null };
};
const failInfo = (e: unknown) => (e instanceof HttpFail ? { status: e.status, errorShape: shape(e.body), ...codesOf(e.body), retryAfter: e.retryAfter } : { network: scrub(e instanceof Error ? e.message : String(e)) });

let lastPoll = 0;
let lastSend = 0;
const wait = async (last: number, gap: number) => {
  const ms = last + gap - Date.now();
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
};

async function call(method: string, path: string, body?: Json, timeoutMs = 45000): Promise<{ status: number; json: Json; ms: number; headers: Headers; bytes: Buffer }> {
  const started = Date.now();
  const url = /^https?:/.test(path) ? path : `${BASE}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(scrub(`network: ${error instanceof Error ? error.message : String(error)}`));
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const json = /json/i.test(res.headers.get("content-type") ?? "") && bytes.length ? (JSON.parse(bytes.toString("utf8")) as Json) : null;
  if (!res.ok) throw new HttpFail(res.status, json, res.headers.get("retry-after"));
  return { status: res.status, json, ms: Date.now() - started, headers: res.headers, bytes };
}

function save(): void {
  mkdirSync(DIR, { recursive: true });
  const file = new URL(`findings-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, DIR);
  writeFileSync(file, scrub(JSON.stringify({ base: BASE, findings }, null, 2)));
  log(`\nRedacted findings: ${decodeURIComponent(file.pathname).replace(/^\/(\w:)/, "$1")} (no text, names, numbers, ids or key; check it, then share it).`);
}

function stopOn(error: unknown): void {
  if (!(error instanceof HttpFail) || ![400, 401, 409, 429].includes(error.status)) return;
  const { code } = codesOf(error.body);
  if (error.status === 400 && code !== 100) return;
  record("stopped", failInfo(error));
  save();
  log(
    error.status === 429
      ? "429: this minute's budget is used up. Stopped; nothing is retried."
      : error.status === 409
        ? "409: another program is polling this key (the Life Organizer server or your test project?). Stop it and run again."
        : `The key was rejected (HTTP ${error.status}). Copy it again from the agent's Chat info → API key.`,
  );
  process.exit(2);
}

type State = { to?: string; offset?: string | null; lastInboundAt?: string };
const readState = (): State => (existsSync(STATE) ? (JSON.parse(readFileSync(STATE, "utf8")) as State) : {});
const writeState = (s: State) => (mkdirSync(DIR, { recursive: true }), writeFileSync(STATE, JSON.stringify(s)));

async function poll(offset: string | null | undefined, timeoutS: number) {
  await wait(lastPoll, MIN_POLL_GAP_MS);
  lastPoll = Date.now();
  const q = new URLSearchParams({ limit: "10", timeout: String(timeoutS) });
  if (offset) q.set("offset", offset);
  const r = await call("GET", `/updates?${q}`, undefined, (timeoutS + 15) * 1000);
  const next = r.json && typeof r.json === "object" ? (r.json as Record<string, Json>).next_offset : null;
  return { ...r, messages: rawMessages(r.json), next: typeof next === "string" ? next : null };
}

async function send(to: string, text: string): Promise<boolean> {
  await wait(lastSend, MIN_SEND_GAP_MS);
  lastSend = Date.now();
  try {
    const r = await call("POST", "/messages", { messaging_product: "whatsapp", to, type: "text", text: { body: text } });
    record("send", { status: r.status, responseShape: shape(r.json), ms: r.ms });
    return true;
  } catch (error) {
    stopOn(error);
    record("send_failed", failInfo(error));
    return false;
  }
}

async function probeMedia(mediaId: string, kind: string): Promise<void> {
  try {
    const meta = await call("GET", `/media/${encodeURIComponent(mediaId)}`);
    const url = meta.json && typeof meta.json === "object" ? (meta.json as Record<string, Json>).url : null;
    const host = typeof url === "string" ? new URL(url).hostname.split(".").slice(-2).join(".") : null; // e.g. fbsbx.com, never the path
    const file = typeof url === "string" ? await call("GET", url, undefined, 60000) : null;
    record("media", { kind, metadataShape: shape(meta.json), metadataFacts: allowedFacts(meta.json), downloadHost: host, downloadType: file?.headers.get("content-type") ?? null, bytes: file?.bytes.length ?? null, magicHex: file?.bytes.subarray(0, 4).toString("hex") ?? null });
    log(`  media: ${kind}, ${file?.bytes.length ?? "?"} bytes from *.${host}`);
  } catch (error) {
    stopOn(error);
    record("media_failed", { kind, ...failInfo(error) });
  }
}

async function listen(): Promise<void> {
  const state = readState();
  const first = await poll(state.offset, 1).catch((e) => (stopOn(e), record("poll_failed", failInfo(e)), save(), process.exit(1)));
  record("envelope", { status: first.status, shape: shape(first.json), backlog: first.messages.length, hasNextOffset: first.next !== null, ms: first.ms });
  if (first.next) state.offset = first.next;
  log("Send your agent now, one at a time: a text, a voice note, a photo and a PDF. Ctrl+C saves and stops.\n");
  process.on("SIGINT", () => (save(), process.exit(0)));
  const seen = new Set<string>();
  let replied = false;
  const until = Date.now() + LISTEN_LIMIT_MS;
  while (Date.now() < until && seen.size < 4) {
    let r;
    try {
      r = await poll(state.offset, 25);
    } catch (error) {
      stopOn(error);
      record("poll_failed", failInfo(error));
      await new Promise((res) => setTimeout(res, 15000));
      continue;
    }
    record("poll", { status: r.status, held: r.ms, messages: r.messages.length, hasNextOffset: r.next !== null });
    for (const raw of r.messages) {
      const m = normalizeMessage(raw);
      if (!m) continue;
      record("message", { kind: m.kind, shape: shape(raw), facts: allowedFacts(raw) });
      log(`  message: ${m.kind}`);
      if (m.chatRef) state.to = m.chatRef;
      state.lastInboundAt = new Date().toISOString();
      if (m.media && !seen.has(m.kind)) await probeMedia(m.media.id, m.kind);
      if (m.kind === "text" && !replied && m.chatRef) {
        replied = await send(m.chatRef, "Life Organizer probe: got your message.");
        log(`  reply sent: ${replied}`);
      }
      seen.add(m.kind);
    }
    if (r.next) state.offset = r.next;
    writeState(state);
  }
  record("done", { kinds: [...seen], replied });
  writeState(state);
  save();
  log("Later, after 30+ minutes without messaging the agent: npm run wa:probe -- proactive --quiet 30");
}

async function proactive(quiet: number): Promise<void> {
  const state = readState();
  if (!state.to || !state.lastInboundAt) return void (log("Run `listen` first (it needs one message from you)."), process.exit(1));
  const fresh = await poll(state.offset, 1).catch((e) => (stopOn(e), null));
  if (fresh?.next) state.offset = fresh.next;
  if (fresh?.messages.length) state.lastInboundAt = new Date().toISOString();
  writeState(state);
  const quietFor = (Date.now() - Date.parse(state.lastInboundAt)) / 60000;
  if (quietFor < quiet) return void (log(`You messaged the agent ${Math.floor(quietFor)} min ago; wait until ${quiet} quiet minutes have passed.`), process.exit(1));
  const ok = await send(state.to, "Life Organizer probe: a reminder the agent sent first.");
  record("proactive", { quietMinutes: Math.floor(quietFor), accepted: ok });
  save();
  log(ok ? "Accepted by the API. Did it arrive on your phone? Tell Claude yes or no." : "Refused; see the findings file for the status and error code.");
}

async function main(): Promise<void> {
  if (!KEY) return void (log("Set WHATSAPP_AGENT_API_KEY in your shell (never in a committed file)."), process.exit(1));
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "listen") return listen();
  if (mode === "proactive") {
    const i = rest.indexOf("--quiet");
    return proactive(i >= 0 ? Number(rest[i + 1]) || 30 : 30);
  }
  log("Usage: npm run wa:probe -- listen | proactive --quiet <minutes>");
  process.exit(1);
}

if (process.argv[1] && /whatsapp-agent-probe/.test(process.argv[1])) void main();
