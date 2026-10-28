import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for the WhatsApp Agent API, in the shapes seen working against the real one
 * (docs/whatsapp-agent-findings.md):
 *   GET /updates?offset&limit&timeout → { entry: [{ changes: [{ value: { messages } }] }], next_offset } or 204
 *   POST /messages { messaging_product: "whatsapp", to: "user:<id>", type: "text", text: { body } }
 *   GET /media/:id → { url, mime_type, file_size }, then GET <url> → the bytes
 *   POST /media (multipart) → { id }, POST /statuses
 * Offsets are opaque tokens ("o<seq>"); a poll with an offset acknowledges everything before it. A second poll on
 * the same key while one is open gets 409 with error code 1752041. Knobs for 400/401/403/429, slow polls and
 * duplicated deliveries.
 */

type Message = Record<string, unknown> & { id: string };

export const USER = "user:4242";

export class FakeAgentServer {
  private server = http.createServer((req, res) => void this.route(req, res));
  private queues = new Map<string, Array<{ seq: number; message: Message }>>();
  private seq = 100;
  private waiters = new Map<string, Array<() => void>>();
  private openPolls = new Map<string, number>();
  readonly media = new Map<string, { bytes: Buffer; type: string }>();
  readonly sent: Array<{ key: string; body: Record<string, unknown> }> = [];
  readonly statuses: Array<Record<string, unknown>> = [];
  readonly polls: Array<{ key: string; offset: string | null }> = [];
  readonly validKeys = new Set<string>();
  /** Keys that answer 400 with error code 100 instead of 401. */
  readonly code100Keys = new Set<string>();
  maxConcurrentPolls = 0;
  /** Next N polls answer 429 (Retry-After in seconds). */
  rateLimitPolls = 0;
  retryAfter = "0";
  /** Next N sends answer with this status. */
  failSends: { count: number; status: number; code?: number } = { count: 0, status: 0 };
  slowMs = 0;
  /** The next poll delivers its messages twice. */
  duplicateNext = false;
  /** The last next_offset handed out. */
  lastOffset: string | null = null;
  base = "";

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    for (const list of this.waiters.values()) for (const w of list) w();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Queues an incoming message (Cloud-API shape) for this key; returns its message id. */
  push(key: string, message: Record<string, unknown>): string {
    const seq = this.seq++;
    const id = `wamid.TEST${seq}`;
    this.queues.set(key, [...(this.queues.get(key) ?? []), { seq, message: { id, from: USER, timestamp: String(Math.floor(Date.now() / 1000)), ...message } }]);
    for (const w of this.waiters.get(key) ?? []) w();
    this.waiters.set(key, []);
    return id;
  }

  text(key: string, body: string): string {
    return this.push(key, { type: "text", text: { body } });
  }

  /** Text of the last message the agent sent. */
  lastSentText(): string {
    const text = this.sent.at(-1)?.body.text as { body?: string } | undefined;
    return String(text?.body ?? "");
  }

  private keyOf(req: http.IncomingMessage): string {
    return (req.headers.authorization ?? "").replace(/^Bearer /, "");
  }

  private json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  private async body(req: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.base);
    const key = this.keyOf(req);
    if (this.code100Keys.has(key)) return this.json(res, 400, { error: { code: 100, message: "Invalid OAuth access token" } });
    if (!this.validKeys.has(key)) return this.json(res, 401, { error: { code: 190, message: "Unauthorized" } });

    if (req.method === "GET" && url.pathname === "/updates") {
      if (this.rateLimitPolls > 0) {
        this.rateLimitPolls -= 1;
        return this.json(res, 429, { error: { code: 4, message: "Too many calls" } }, { "retry-after": this.retryAfter });
      }
      if ((this.openPolls.get(key) ?? 0) > 0) return this.json(res, 409, { error: { code: 1752041, message: "Updates poll already active" } });
      this.openPolls.set(key, (this.openPolls.get(key) ?? 0) + 1);
      this.maxConcurrentPolls = Math.max(this.maxConcurrentPolls, this.openPolls.get(key) ?? 0);
      const offset = url.searchParams.get("offset");
      this.polls.push({ key, offset });
      try {
        if (this.slowMs) await new Promise((r) => setTimeout(r, this.slowMs));
        const from = offset ? Number(offset.replace(/^o/, "")) : 0;
        // Acknowledge: everything before the offset is gone for good.
        this.queues.set(key, (this.queues.get(key) ?? []).filter((q) => q.seq >= from));
        const pending = () => this.queues.get(key) ?? [];
        const timeoutS = Number(url.searchParams.get("timeout") ?? 0);
        if (!pending().length && timeoutS > 0) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, Math.min(timeoutS * 1000, 2000));
            this.waiters.set(key, [...(this.waiters.get(key) ?? []), () => (clearTimeout(t), resolve())]);
            req.once("close", () => (clearTimeout(t), resolve()));
          });
        }
        const batch = pending().slice(0, Number(url.searchParams.get("limit") ?? 50));
        if (res.destroyed) return;
        if (!batch.length) {
          res.writeHead(204);
          return void res.end();
        }
        let messages = batch.map((q) => q.message);
        if (this.duplicateNext) {
          messages = [...messages, ...messages];
          this.duplicateNext = false;
        }
        this.lastOffset = `o${batch[batch.length - 1].seq + 1}`;
        this.json(res, 200, { object: "whatsapp_agent", entry: [{ id: "agent", changes: [{ field: "messages", value: { messages } }] }], next_offset: this.lastOffset });
      } finally {
        this.openPolls.set(key, (this.openPolls.get(key) ?? 1) - 1);
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/messages") {
      const body = JSON.parse((await this.body(req)).toString("utf8") || "{}") as Record<string, unknown>;
      if (this.failSends.count > 0) {
        this.failSends.count -= 1;
        return this.json(res, this.failSends.status, { error: { code: this.failSends.code ?? this.failSends.status } }, this.failSends.status === 429 ? { "retry-after": "0" } : {});
      }
      const text = body.text as { body?: unknown } | undefined;
      if (body.messaging_product !== "whatsapp" || typeof body.to !== "string" || body.type !== "text" || typeof text?.body !== "string") {
        return this.json(res, 400, { error: { code: 100, message: "Invalid parameter" } });
      }
      if (text.body.length > 4096) return this.json(res, 400, { error: { code: 131009, message: "text too long" } });
      this.sent.push({ key, body });
      return this.json(res, 200, { messaging_product: "whatsapp", messages: [{ id: `wamid.OUT${this.sent.length}` }] });
    }
    const media = /^\/media\/(.+)$/.exec(url.pathname);
    if (req.method === "GET" && media) {
      const id = decodeURIComponent(media[1]);
      const m = this.media.get(id);
      if (!m) return this.json(res, 404, { error: { code: 100, message: "Unknown media" } });
      return this.json(res, 200, { id, url: `${this.base}/download/${encodeURIComponent(id)}`, mime_type: m.type, file_size: m.bytes.length });
    }
    const dl = /^\/download\/(.+)$/.exec(url.pathname);
    if (req.method === "GET" && dl) {
      const m = this.media.get(decodeURIComponent(dl[1]));
      if (!m) return this.json(res, 404, {});
      res.writeHead(200, { "content-type": m.type, "content-length": String(m.bytes.length) });
      return void res.end(m.bytes);
    }
    if (req.method === "POST" && url.pathname === "/media") {
      await this.body(req);
      return this.json(res, 200, { id: `up-${this.media.size + 1}` });
    }
    if (req.method === "POST" && url.pathname === "/statuses") {
      this.statuses.push(JSON.parse((await this.body(req)).toString("utf8") || "{}"));
      return this.json(res, 200, { success: true });
    }
    this.json(res, 404, { error: { code: 404 } });
  }
}

/** A one-page PDF with a text layer (no OCR needed), xref offsets computed. */
export function textPdf(lines: string[]): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `(${l.replace(/[()\\]/g, "\\$&")}) Tj T*`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
