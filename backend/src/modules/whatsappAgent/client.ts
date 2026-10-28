import { agentBaseUrl } from "./config.js";
import { normalizeUpdate, updatesOf, type AgentUpdate } from "./shapes.js";

/**
 * WhatsApp Agent HTTP API (unverified: from a community implementation, see docs/whatsapp-agent-findings.md).
 * Bearer key; GET /updates (long poll), POST /messages, GET /media/{id}, POST /media, POST /statuses.
 *
 * The key lives in a private field: it is never part of an error message, a log line, JSON.stringify or
 * util.inspect output. Errors carry only the HTTP status and the API's numeric error code.
 */

export class AgentError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly code: number | null = null) {
    super(message);
  }
}
/** 401, or 400 with error code 100: the key is wrong, revoked or regenerated. */
export class InvalidKeyError extends AgentError {}
/** 409: another poller is using this key. */
export class ConflictError extends AgentError {}
/** 429: this minute's budget is used up. */
export class RateLimitedError extends AgentError {
  constructor(readonly retryAfterMs: number | null, status = 429) {
    super("Rate limited", status);
  }
}
/** 403 (code 131005): only the agent's creator can chat with it. */
export class ForbiddenError extends AgentError {}
/** No answer, a timeout or a 5xx: worth retrying later. */
export class NetworkError extends AgentError {}
export class MediaTooLargeError extends AgentError {}

export type GetUpdatesOptions = { offset: string | null; limit: number; timeoutS: number; signal?: AbortSignal };

export interface WhatsAppAgentClient {
  getUpdates(opts: GetUpdatesOptions): Promise<AgentUpdate[]>;
  sendText(text: string, chatRef: string | null): Promise<{ messageId: string | null }>;
  getMedia(mediaId: string, maxBytes: number): Promise<{ bytes: Buffer; mimeType: string | null }>;
  uploadMedia(bytes: Buffer, mimeType: string, fileName: string): Promise<{ mediaId: string | null }>;
  markRead(messageId: string, chatRef: string | null): Promise<void>;
}

type Json = unknown;

function errorCode(body: Json): number | null {
  const e = body && typeof body === "object" ? ((body as Record<string, Json>).error ?? body) : null;
  const code = e && typeof e === "object" ? (e as Record<string, Json>).code : null;
  return typeof code === "number" ? code : typeof code === "string" && /^\d+$/.test(code) ? Number(code) : null;
}

function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const s = Number(header);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/** Maps a failed response to a typed error. Exported for the contract tests. */
export function errorFor(status: number, body: Json, retryAfter: string | null): AgentError {
  const code = errorCode(body);
  if (status === 401 || (status === 400 && code === 100)) return new InvalidKeyError(`Key rejected (HTTP ${status})`, status, code);
  if (status === 403) return new ForbiddenError(`Not allowed (HTTP 403${code ? `, code ${code}` : ""})`, status, code);
  if (status === 409) return new ConflictError("Another poller is using this key (HTTP 409)", status, code);
  if (status === 429) return new RateLimitedError(retryAfterMs(retryAfter));
  if (status >= 500) return new NetworkError(`Server error (HTTP ${status})`, status, code);
  return new AgentError(`Request failed (HTTP ${status}${code ? `, code ${code}` : ""})`, status, code);
}

export class HttpAgentClient implements WhatsAppAgentClient {
  readonly #key: string;

  constructor(apiKey: string, private readonly baseUrl = agentBaseUrl()) {
    this.#key = apiKey;
  }

  toJSON(): Record<string, string> {
    return { client: "whatsapp-agent" };
  }

  private async request(method: string, path: string, init: { body?: Json; raw?: { bytes: Buffer; type: string; name: string }; timeoutMs: number; signal?: AbortSignal; maxBytes?: number }): Promise<Response> {
    const signals = [AbortSignal.timeout(init.timeoutMs), ...(init.signal ? [init.signal] : [])];
    let body: BodyInit | undefined;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#key}`, Accept: "application/json" };
    if (init.raw) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(init.raw.bytes)], { type: init.raw.type }), init.raw.name);
      body = form;
    } else if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { method, headers, body, signal: AbortSignal.any(signals) });
    } catch (error) {
      if (init.signal?.aborted) throw error; // our own shutdown, not a network problem
      throw new NetworkError(error instanceof Error && error.name === "TimeoutError" ? "Timed out" : "No connection");
    }
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      throw errorFor(res.status, json, res.headers.get("retry-after"));
    }
    return res;
  }

  async getUpdates(opts: GetUpdatesOptions): Promise<AgentUpdate[]> {
    const q = new URLSearchParams({ limit: String(opts.limit), timeout: String(opts.timeoutS) });
    if (opts.offset !== null) q.set("offset", opts.offset);
    const res = await this.request("GET", `/updates?${q}`, { timeoutMs: (opts.timeoutS + 15) * 1000, signal: opts.signal });
    const json = await res.json().catch(() => null);
    return updatesOf(json)
      .map(normalizeUpdate)
      .filter((u): u is AgentUpdate => u !== null);
  }

  async sendText(text: string, chatRef: string | null): Promise<{ messageId: string | null }> {
    // Unverified body: the probe records which form the API accepts (docs/whatsapp-agent-findings.md).
    const res = await this.request("POST", "/messages", { body: chatRef ? { chat_id: chatRef, text } : { text }, timeoutMs: 20000 });
    const json = (await res.json().catch(() => null)) as Record<string, Json> | null;
    const id = json?.message_id ?? json?.id ?? (json?.result as Record<string, Json> | undefined)?.message_id;
    return { messageId: typeof id === "string" || typeof id === "number" ? String(id) : null };
  }

  async getMedia(mediaId: string, maxBytes: number): Promise<{ bytes: Buffer; mimeType: string | null }> {
    const res = await this.request("GET", `/media/${encodeURIComponent(mediaId)}`, { timeoutMs: 60000 });
    const type = res.headers.get("content-type");
    if (type && /json/i.test(type)) {
      // Some APIs answer with a download URL instead of the bytes; follow it (with the key only on the same host).
      const json = (await res.json()) as Record<string, Json>;
      const url = [json.url, json.download_url, (json.result as Record<string, Json> | undefined)?.url].find((u) => typeof u === "string") as string | undefined;
      if (!url) throw new AgentError("Media answer had no file");
      const sameHost = new URL(url).host === new URL(this.baseUrl).host;
      const file = await fetch(url, { headers: sameHost ? { Authorization: `Bearer ${this.#key}` } : {}, signal: AbortSignal.timeout(60000) }).catch(() => {
        throw new NetworkError("No connection");
      });
      if (!file.ok) throw errorFor(file.status, null, file.headers.get("retry-after"));
      return { bytes: await readCapped(file, maxBytes), mimeType: file.headers.get("content-type") ?? (typeof json.mime_type === "string" ? json.mime_type : null) };
    }
    return { bytes: await readCapped(res, maxBytes), mimeType: type };
  }

  async uploadMedia(bytes: Buffer, mimeType: string, fileName: string): Promise<{ mediaId: string | null }> {
    const res = await this.request("POST", "/media", { raw: { bytes, type: mimeType, name: fileName }, timeoutMs: 60000 });
    const json = (await res.json().catch(() => null)) as Record<string, Json> | null;
    const id = json?.media_id ?? json?.id;
    return { mediaId: typeof id === "string" ? id : null };
  }

  async markRead(messageId: string, chatRef: string | null): Promise<void> {
    await this.request("POST", "/statuses", { body: { message_id: messageId, status: "read", ...(chatRef ? { chat_id: chatRef } : {}) }, timeoutMs: 15000 });
  }
}

/** Reads a body, stopping as soon as it passes `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new MediaTooLargeError("File too large");
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > max) throw new MediaTooLargeError("File too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

let factory: (apiKey: string) => WhatsAppAgentClient = (apiKey) => new HttpAgentClient(apiKey);
export function createAgentClient(apiKey: string): WhatsAppAgentClient {
  return factory(apiKey);
}
/** Test hook. */
export function setAgentClientFactory(f: ((apiKey: string) => WhatsAppAgentClient) | null): void {
  factory = f ?? ((apiKey) => new HttpAgentClient(apiKey));
}
