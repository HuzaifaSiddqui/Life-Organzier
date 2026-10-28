import { agentBaseUrl } from "./config.js";
import { parseUpdates, type UpdateBatch } from "./shapes.js";

/**
 * WhatsApp Agent HTTP API (docs/whatsapp-agent-findings.md): Bearer key; GET /updates (long poll, Cloud-API style
 * envelope, opaque next_offset), POST /messages (Cloud-API message body, `to` = the sender's "user:<id>"),
 * GET /media/{id} (metadata with a download URL on a Meta host), POST /media, POST /statuses.
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
/** 409 (error code 1752041): another poller is using this key. */
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
  getUpdates(opts: GetUpdatesOptions): Promise<UpdateBatch>;
  /** `to` is the "user:<id>" of a message the user sent: the agent can only answer someone it heard from. */
  sendText(text: string, to: string | null): Promise<{ messageId: string | null }>;
  getMedia(mediaId: string, maxBytes: number): Promise<{ bytes: Buffer; mimeType: string | null }>;
  uploadMedia(bytes: Buffer, mimeType: string, fileName: string): Promise<{ mediaId: string | null }>;
  markRead(messageId: string): Promise<void>;
}

/** Raised before calling the API when there is nobody to send to yet (the user hasn't messaged the agent). */
export class NoRecipientError extends AgentError {}

/** Download URLs from GET /media/{id} must be HTTPS on a Meta host (the key is sent with the download). */
export function trustedMediaUrl(url: URL, baseUrl: string): boolean {
  if (url.host === new URL(baseUrl).host) return true; // same API host (also how the tests' fake server serves files)
  return url.protocol === "https:" && /(^|\.)(whatsapp\.com|whatsapp\.net|fbcdn\.net|facebook\.com|fbsbx\.com)$/i.test(url.hostname);
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
      form.append("messaging_product", "whatsapp");
      form.append("type", init.raw.type);
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

  async getUpdates(opts: GetUpdatesOptions): Promise<UpdateBatch> {
    const q = new URLSearchParams({ limit: String(opts.limit), timeout: String(opts.timeoutS) });
    if (opts.offset !== null) q.set("offset", opts.offset);
    const res = await this.request("GET", `/updates?${q}`, { timeoutMs: (opts.timeoutS + 15) * 1000, signal: opts.signal });
    if (res.status === 204) return { updates: [], nextOffset: null }; // nothing new; keep the offset
    return parseUpdates(await res.json().catch(() => null));
  }

  async sendText(text: string, to: string | null): Promise<{ messageId: string | null }> {
    if (!to) throw new NoRecipientError("Nobody to send to yet");
    const res = await this.request("POST", "/messages", { body: { messaging_product: "whatsapp", to, type: "text", text: { body: text } }, timeoutMs: 20000 });
    const json = (await res.json().catch(() => null)) as Record<string, Json> | null;
    const first = Array.isArray(json?.messages) ? (json?.messages[0] as Record<string, Json> | undefined) : undefined;
    const id = first?.id ?? json?.id;
    return { messageId: typeof id === "string" ? id : null };
  }

  /** GET /media/{id} gives { url, mime_type, file_size? }; the file is then downloaded from that (Meta) URL with the key. */
  async getMedia(mediaId: string, maxBytes: number): Promise<{ bytes: Buffer; mimeType: string | null }> {
    if (!/^[A-Za-z0-9._:-]+$/.test(mediaId)) throw new AgentError("Invalid media id");
    const res = await this.request("GET", `/media/${encodeURIComponent(mediaId)}`, { timeoutMs: 30000 });
    const json = (await res.json().catch(() => null)) as Record<string, Json> | null;
    if (typeof json?.file_size === "number" && json.file_size > maxBytes) throw new MediaTooLargeError("File too large");
    if (typeof json?.url !== "string") throw new AgentError("Media answer had no download URL");
    const url = new URL(json.url);
    if (!trustedMediaUrl(url, this.baseUrl)) throw new AgentError("Media URL is not on a WhatsApp host");
    const file = await fetch(url, { headers: { Authorization: `Bearer ${this.#key}`, Accept: "application/octet-stream" }, signal: AbortSignal.timeout(60000) }).catch(() => {
      throw new NetworkError("No connection");
    });
    if (!file.ok) throw errorFor(file.status, null, file.headers.get("retry-after"));
    const declared = typeof json.mime_type === "string" ? json.mime_type : null;
    return { bytes: await readCapped(file, maxBytes), mimeType: declared ?? file.headers.get("content-type") };
  }

  async uploadMedia(bytes: Buffer, mimeType: string, fileName: string): Promise<{ mediaId: string | null }> {
    const res = await this.request("POST", "/media", { raw: { bytes, type: mimeType, name: fileName }, timeoutMs: 60000 });
    const json = (await res.json().catch(() => null)) as Record<string, Json> | null;
    return { mediaId: typeof json?.id === "string" ? json.id : null };
  }

  /** Read receipt in the Cloud API form. Not seen working yet; callers treat it as best effort. */
  async markRead(messageId: string): Promise<void> {
    await this.request("POST", "/statuses", { body: { messaging_product: "whatsapp", status: "read", message_id: messageId }, timeoutMs: 15000 });
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
