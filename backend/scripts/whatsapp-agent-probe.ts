/**
 * WhatsApp Agent probe (Phase 0). Finds out what the agent API really does before the app relies on it.
 *
 *   cd backend
 *   WHATSAPP_AGENT_API_KEY=... npm run wa:probe -- listen               # steps 1-3 (about 10 minutes)
 *   WHATSAPP_AGENT_API_KEY=... npm run wa:probe -- proactive --quiet 30 # step 4, a separate run later
 *
 * Privacy: the key is never printed (it is scrubbed from every error too). Message text, names, phone numbers
 * and ids are never printed or saved: only field names and value TYPES, plus a short allowlist of non-personal
 * facts (MIME type, byte size, duration, the first 4 bytes of a media file as hex, HTTP status codes, timings).
 * The chat reference needed for step 4 is kept in backend/.probe/state.json (git-ignored, never printed).
 *
 * Rate limits: polls are spaced so there are at most 12 a minute (limit 15), sends at most 1 every 10 s (limit
 * 12). A 429 stops the probe at once; it never retries fast or tries to hit a limit on purpose.
 *
 * Stop the Life Organizer server first if it is connected with the same key: a second poller gets 409.
 */
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { shape, updatesOf } from "../src/modules/whatsappAgent/shapes.js";

const KEY = process.env.WHATSAPP_AGENT_API_KEY ?? "";
const BASE = (process.env.WHATSAPP_AGENT_BASE_URL ?? "https://api.whatsapp.com/agent/v1").replace(/\/$/, "");
const DIR = new URL("../.probe/", import.meta.url);
const STATE = new URL("state.json", DIR);
const POLL_TIMEOUT_S = 25;
const MIN_POLL_GAP_MS = 5000;
const MIN_SEND_GAP_MS = 10000;
const LISTEN_LIMIT_MS = 12 * 60000;

type Json = unknown;
type Finding = { step: string; at: string; [k: string]: unknown };
const findings: Finding[] = [];

/** Never let the key reach the console, a file or an error message. */
function scrub(text: string): string {
  return KEY ? text.split(KEY).join("[key]") : text;
}
function log(line: string): void {
  console.log(scrub(line));
}
function record(step: string, data: Record<string, unknown>): void {
  findings.push({ step, at: new Date().toISOString(), ...data });
}

/** Non-personal facts worth keeping as values: MIME types, sizes, durations, message kinds. */
export function allowedFacts(value: Json, path = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, Json>)) allowedFacts(v, path ? `${path}.${k}` : k, out);
    return out;
  }
  const key = path.split(".").pop() ?? "";
  if (/mime|content_?type/i.test(key) && typeof value === "string" && /^[\w.+-]+\/[\w.+-]+(;.*)?$/.test(value)) out[path] = value;
  else if (/(size|bytes|length|duration|seconds|width|height)$/i.test(key) && typeof value === "number") out[path] = value;
  else if (/^(type|kind|message_?type|status)$/i.test(key) && typeof value === "string" && /^[a-z_]{1,24}$/i.test(value)) out[path] = value;
  return out;
}

class HttpFail extends Error {
  constructor(readonly status: number, readonly body: Json, readonly retryAfter: string | null) {
    super(`HTTP ${status}`);
  }
}

let lastPollAt = 0;
let lastSendAt = 0;
async function gap(last: number, min: number): Promise<void> {
  const wait = last + min - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function call(method: string, path: string, body?: Json, timeoutMs = 40000): Promise<{ status: number; headers: Headers; json: Json; bytes: Buffer | null; ms: number }> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(scrub(`network: ${error instanceof Error ? error.message : String(error)}`));
  }
  const type = res.headers.get("content-type") ?? "";
  const raw = Buffer.from(await res.arrayBuffer());
  let json: Json = null;
  if (/json/i.test(type)) json = JSON.parse(raw.toString("utf8") || "null");
  if (!res.ok) throw new HttpFail(res.status, json, res.headers.get("retry-after"));
  return { status: res.status, headers: res.headers, json, bytes: /json/i.test(type) ? null : raw, ms: Date.now() - started };
}

function failInfo(error: unknown): Record<string, unknown> {
  if (error instanceof HttpFail) return { status: error.status, errorShape: shape(error.body), errorFacts: errorCodes(error.body), retryAfter: error.retryAfter };
  return { network: scrub(error instanceof Error ? error.message : String(error)) };
}
/** Numeric error codes and short error type names are not personal; messages may echo input, so they are not kept. */
function errorCodes(body: Json): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (v: Json, p: string) => {
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, Json>)) walk(x, p ? `${p}.${k}` : k);
    else if (/code|subcode/i.test(p) && (typeof v === "number" || (typeof v === "string" && /^[\w-]{1,32}$/.test(v)))) out[p] = v;
    else if (/(^|\.)type$/i.test(p) && typeof v === "string" && /^[\w]{1,40}$/.test(v)) out[p] = v;
  };
  walk(body, "");
  return out;
}

function stopOn429(error: unknown): void {
  if (error instanceof HttpFail && error.status === 429) {
    record("rate_limited", failInfo(error));
    save();
    log("Got 429 (rate budget exhausted). Stopping now; nothing is retried. Findings saved.");
    process.exit(2);
  }
  if (error instanceof HttpFail && (error.status === 401 || error.status === 400) && JSON.stringify(errorCodes(error.body)).includes("100")) {
    record("invalid_key", failInfo(error));
    save();
    log(`The key was rejected (HTTP ${error.status}). Copy it again from WhatsApp > the agent > Chat info > API key.`);
    process.exit(3);
  }
  if (error instanceof HttpFail && error.status === 401) {
    record("invalid_key", failInfo(error));
    save();
    log("The key was rejected (HTTP 401).");
    process.exit(3);
  }
  if (error instanceof HttpFail && error.status === 409) {
    record("conflict", failInfo(error));
    save();
    log("HTTP 409: another poller is using this key (is the Life Organizer server connected with it?). Stop it and run again.");
    process.exit(4);
  }
}

export function updateIdOf(u: Json): number | string | null {
  if (!u || typeof u !== "object") return null;
  const o = u as Record<string, Json>;
  for (const k of ["update_id", "updateId", "id", "offset"]) if (typeof o[k] === "number" || typeof o[k] === "string") return o[k] as number | string;
  return null;
}
/** What kind of message an update carries, judged by which keys are present. */
export function kindOf(u: Json): string {
  const keys = new Set<string>();
  const walk = (v: Json, d: number) => {
    if (d > 4 || !v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v as Record<string, Json>)) {
      keys.add(k.toLowerCase());
      walk(x, d + 1);
    }
  };
  walk(u, 0);
  const facts = JSON.stringify(allowedFacts(u)).toLowerCase();
  if (keys.has("voice") || keys.has("audio") || /audio\//.test(facts)) return "voice";
  if (keys.has("document") || /application\/pdf/.test(facts)) return "document";
  if (keys.has("image") || keys.has("photo") || /image\//.test(facts)) return "image";
  if (keys.has("text") || keys.has("body")) return "text";
  return "other";
}
/** A media id: a string under a media-ish key, or an `id` inside a media object. Never printed. */
export function mediaIdOf(u: Json): string | null {
  let found: string | null = null;
  const walk = (v: Json, parent: string, d: number) => {
    if (found || d > 6 || !v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v as Record<string, Json>)) {
      if (typeof x === "string" && (/^(media|file)_?id$/i.test(k) || (k === "id" && /voice|audio|image|photo|document|media|file|sticker|video/i.test(parent)))) {
        found = x;
        return;
      }
      walk(x, k, d + 1);
    }
  };
  walk(u, "", 0);
  return found;
}
/** Where the chat id lives, as a dotted path; its value is kept only in the git-ignored state file. */
export function chatRefOf(u: Json): { path: string; value: string | number } | null {
  let found: { path: string; value: string | number } | null = null;
  const walk = (v: Json, p: string, d: number) => {
    if (found || d > 5 || !v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v as Record<string, Json>)) {
      const path = p ? `${p}.${k}` : k;
      if (/^(chat_?id|conversation_?id|thread_?id)$/i.test(k) && (typeof x === "string" || typeof x === "number")) found = { path, value: x };
      else if (/^chat$/i.test(k) && x && typeof x === "object" && ["string", "number"].includes(typeof (x as Record<string, Json>).id)) found = { path: `${path}.id`, value: (x as Record<string, string | number>).id };
      else walk(x, path, d + 1);
    }
  };
  walk(u, "", 0);
  return found;
}

type State = { chatRef?: string | number; chatRefPath?: string; sendVariant?: number; lastInboundAt?: string; lastOffset?: number | string | null };
function readState(): State {
  return existsSync(STATE) ? (JSON.parse(readFileSync(STATE, "utf8")) as State) : {};
}
function writeState(s: State): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}
function save(): void {
  mkdirSync(DIR, { recursive: true });
  const file = new URL(`findings-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, DIR);
  const text = scrub(JSON.stringify({ base: BASE, findings }, null, 2));
  writeFileSync(file, text);
  log(`\nRedacted findings written to ${decodeURIComponent(file.pathname).replace(/^\/(\w:)/, "$1")}`);
  log("Read it, then paste it to Claude (it holds no message text, names, numbers, ids or key).");
}

async function poll(offset: number | string | null, timeoutS: number): Promise<{ list: Json[]; json: Json; ms: number }> {
  await gap(lastPollAt, MIN_POLL_GAP_MS);
  lastPollAt = Date.now();
  const q = new URLSearchParams({ limit: "10", timeout: String(timeoutS) });
  if (offset !== null) q.set("offset", String(offset));
  const r = await call("GET", `/updates?${q}`, undefined, (timeoutS + 15) * 1000);
  return { list: updatesOf(r.json), json: r.json, ms: r.ms };
}

const SEND_VARIANTS: Array<(chat: string | number | undefined, text: string) => Json> = [
  (_c, text) => ({ text }),
  (chat, text) => ({ chat_id: chat, text }),
  (chat, text) => ({ to: chat, text }),
  (chat, text) => ({ chat_id: chat, type: "text", text: { body: text } }),
];
function customVariant(): ((chat: string | number | undefined, text: string) => Json) | null {
  const t = process.env.WHATSAPP_AGENT_PROBE_SEND_BODY;
  if (!t) return null;
  return (chat, text) => JSON.parse(t.replace(/"\$CHAT"/g, JSON.stringify(chat ?? null)).replace(/\$TEXT/g, text.replace(/"/g, '\\"')));
}

async function send(text: string, state: State, only?: number): Promise<{ ok: boolean; variant: number | null }> {
  const custom = customVariant();
  const variants = custom ? [custom] : SEND_VARIANTS;
  const order = only !== undefined && !custom ? [only] : variants.map((_, i) => i);
  for (const i of order) {
    await gap(lastSendAt, MIN_SEND_GAP_MS);
    lastSendAt = Date.now();
    const body = variants[i](state.chatRef, text);
    try {
      const r = await call("POST", "/messages", body);
      record("send", { variant: custom ? "custom" : i, requestShape: shape(body), status: r.status, responseShape: shape(r.json), ms: r.ms });
      log(`  POST /messages (body form ${custom ? "custom" : i}) → HTTP ${r.status}`);
      return { ok: true, variant: custom ? null : i };
    } catch (error) {
      stopOn429(error);
      record("send_failed", { variant: custom ? "custom" : i, requestShape: shape(body), ...failInfo(error) });
      log(`  POST /messages (body form ${custom ? "custom" : i}) → ${error instanceof HttpFail ? `HTTP ${error.status}` : "network error"}`);
      if (error instanceof HttpFail && error.status === 403) break; // 131005: not the agent's creator; other forms won't help
    }
  }
  return { ok: false, variant: null };
}

async function probeMedia(u: Json, kind: string): Promise<void> {
  const id = mediaIdOf(u);
  if (!id) {
    record("media", { kind, mediaId: "not found in update", facts: allowedFacts(u) });
    return;
  }
  try {
    const r = await call("GET", `/media/${encodeURIComponent(id)}`, undefined, 60000);
    const contentType = r.headers.get("content-type");
    if (r.bytes) {
      record("media", { kind, mediaId: `string(${id.length})`, returns: "bytes", contentType, bytes: r.bytes.length, magicHex: r.bytes.subarray(0, 4).toString("hex"), contentLength: r.headers.get("content-length"), ms: r.ms, updateFacts: allowedFacts(u) });
      log(`  GET /media/{id} → bytes (${contentType}, ${r.bytes.length} bytes, starts ${r.bytes.subarray(0, 4).toString("hex")})`);
    } else {
      record("media", { kind, mediaId: `string(${id.length})`, returns: "json", contentType, responseShape: shape(r.json), responseFacts: allowedFacts(r.json), ms: r.ms, updateFacts: allowedFacts(u) });
      log(`  GET /media/{id} → JSON (see findings; a URL field means a second download step)`);
    }
  } catch (error) {
    stopOn429(error);
    record("media_failed", { kind, ...failInfo(error) });
    log(`  GET /media/{id} failed (${error instanceof HttpFail ? `HTTP ${error.status}` : "network"})`);
  }
}

async function listen(): Promise<void> {
  const state = readState();
  log("Step 1: first poll (short), to see the envelope and any backlog.");
  let first;
  try {
    first = await poll(null, 1);
  } catch (error) {
    stopOn429(error);
    record("poll_failed", failInfo(error));
    save();
    log("The first poll failed; see the findings file.");
    process.exit(1);
  }
  record("poll_envelope", { shape: shape(first.json), backlog: first.list.length, ms: first.ms });
  log(`  envelope recorded; backlog of ${first.list.length} update(s)`);

  // Offset / ack semantics: does an un-acked update come back, and does offset = last + 1 clear it?
  const firstIds = first.list.map(updateIdOf);
  if (first.list.length) {
    const again = await poll(null, 1);
    const repeated = again.list.map(updateIdOf).filter((id) => firstIds.includes(id)).length;
    const last = firstIds[firstIds.length - 1];
    const next = typeof last === "number" ? last + 1 : last;
    const after = await poll(next, 1);
    const stillThere = after.list.map(updateIdOf).filter((id) => firstIds.includes(id)).length;
    record("offset_semantics", {
      updateIdType: typeof last,
      idsIncreaseBy1: firstIds.length > 1 && typeof last === "number" ? firstIds.every((id, i) => i === 0 || (id as number) - (firstIds[i - 1] as number) === 1) : null,
      redeliveredWithoutOffset: repeated,
      redeliveredAfterOffsetLastPlus1: stillThere,
      offsetUsed: typeof last === "number" ? "last+1" : "last id (string)",
    });
    log(`  without offset ${repeated}/${firstIds.length} came back; with offset=last+1 ${stillThere} came back`);
    state.lastOffset = next;
  } else {
    record("offset_semantics", { note: "no backlog; re-run step 1 later or read the per-message records below" });
  }

  log("\nStep 2: now send your agent, in this order, waiting for each to be seen here:");
  log("  1) a short text   2) a voice note (a few seconds)   3) a photo   4) a PDF");
  log(`Polling with timeout=${POLL_TIMEOUT_S}s for up to ${LISTEN_LIMIT_MS / 60000} minutes; Ctrl+C saves and stops.\n`);
  process.on("SIGINT", () => {
    save();
    process.exit(0);
  });
  const seen = new Set<string>();
  const seenIds = new Set<string>();
  let offset = state.lastOffset ?? null;
  let replied = false;
  const until = Date.now() + LISTEN_LIMIT_MS;
  let previousId: number | null = null;
  while (Date.now() < until && seen.size < 4) {
    let r;
    try {
      r = await poll(offset, POLL_TIMEOUT_S);
    } catch (error) {
      stopOn429(error);
      record("poll_failed", failInfo(error));
      log(`  poll failed (${error instanceof HttpFail ? `HTTP ${error.status}` : "network"}); waiting 15 s`);
      await new Promise((res) => setTimeout(res, 15000));
      continue;
    }
    record("poll", { held: r.ms, updates: r.list.length });
    for (const u of r.list) {
      const id = updateIdOf(u);
      const dup = seenIds.has(String(id));
      seenIds.add(String(id));
      const kind = kindOf(u);
      const ref = chatRefOf(u);
      const step = typeof id === "number" && previousId !== null ? id - previousId : null;
      if (typeof id === "number") previousId = id;
      record("update", { kind, duplicate: dup, idStep: step, shape: shape(u), facts: allowedFacts(u), chatRefPath: ref?.path ?? null });
      log(`  update: ${kind}${dup ? " (duplicate)" : ""}`);
      if (ref) {
        state.chatRef = ref.value;
        state.chatRefPath = ref.path;
      }
      state.lastInboundAt = new Date().toISOString();
      if (!dup && kind !== "text" && kind !== "other") await probeMedia(u, kind);
      if (!dup && kind === "text" && !replied) {
        log("Step 3: replying once to your text.");
        const s = await send("Life Organizer probe: got your message.", state);
        replied = true;
        if (s.variant !== null) state.sendVariant = s.variant;
      }
      seen.add(kind);
      if (id !== null) offset = typeof id === "number" ? id + 1 : id;
    }
    state.lastOffset = offset;
    writeState(state);
  }
  record("listen_done", { kindsSeen: [...seen], replied });
  writeState(state);
  save();
  log(`\nDone. Seen: ${[...seen].join(", ") || "nothing"}. Run step 4 later: npm run wa:probe -- proactive --quiet 30`);
}

async function proactive(quietMinutes: number): Promise<void> {
  const state = readState();
  if (!state.lastInboundAt) {
    log("Run `listen` first (step 4 needs to know when you last messaged the agent).");
    process.exit(1);
  }
  const quietFor = (Date.now() - Date.parse(state.lastInboundAt)) / 60000;
  // A quick check that nothing new arrived (that would make this not agent-first).
  let fresh = 0;
  try {
    const r = await poll(state.lastOffset ?? null, 1);
    fresh = r.list.length;
    if (fresh) {
      const last = updateIdOf(r.list[r.list.length - 1]);
      state.lastOffset = typeof last === "number" ? last + 1 : last;
      state.lastInboundAt = new Date().toISOString();
      writeState(state);
    }
  } catch (error) {
    stopOn429(error);
  }
  if (fresh || quietFor < quietMinutes) {
    log(`You messaged the agent ${fresh ? "just now" : `${Math.floor(quietFor)} min ago`}; wait until ${quietMinutes} minutes have passed with no message, then run this again.`);
    process.exit(1);
  }
  log(`Step 4: sending one message with no inbound message for ${Math.floor(quietFor)} minutes.`);
  const s = await send("Life Organizer probe: this is a test reminder the agent sent first.", state, state.sendVariant);
  record("proactive", { quietMinutes: Math.floor(quietFor), accepted: s.ok });
  save();
  log(s.ok ? "The API accepted it. Check your phone: did it arrive? Tell Claude yes/no (acceptance alone isn't delivery)." : "The API refused it; see the findings file for the status and error code.");
}

async function main(): Promise<void> {
  if (!KEY) {
    log("Set WHATSAPP_AGENT_API_KEY in your shell (not in a file you commit). The key is never printed.");
    process.exit(1);
  }
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
