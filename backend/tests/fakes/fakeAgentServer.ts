import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for the WhatsApp Agent API (unverified shapes, as assumed in src/modules/whatsappAgent/shapes.ts).
 * GET /updates long-polls with Telegram-style offsets (offset = last id + 1 acknowledges), POST /messages,
 * GET /media/:id, POST /media, POST /statuses. Knobs for 400/401/403/409/429, slow polls and duplicated updates.
 * A second poll on the same key while one is open gets 409, like the real API is said to.
 */

type Update = { update_id: number; message: Record<string, unknown> };

export class FakeAgentServer {
  private server = http.createServer((req, res) => void this.route(req, res));
  private updates = new Map<string, Update[]>();
  private nextId = 100;
  private waiters = new Map<string, Array<() => void>>();
  private openPolls = new Map<string, number>();
  readonly media = new Map<string, { bytes: Buffer; type: string } | { url: true; bytes: Buffer; type: string }>();
  readonly sent: Array<{ key: string; body: Record<string, unknown> }> = [];
  readonly statuses: Array<Record<string, unknown>> = [];
  readonly polls: Array<{ key: string; offset: string | null }> = [];
  /** Keys the API accepts. */
  readonly validKeys = new Set<string>();
  /** Keys that answer 400 with error code 100 instead of 401. */
  readonly code100Keys = new Set<string>();
  maxConcurrentPolls = 0;
  /** Next N polls answer 429 (Retry-After in seconds). */
  rateLimitPolls = 0;
  retryAfter = "0";
  /** Next N sends answer with this status. */
  failSends: { count: number; status: number; code?: number } = { count: 0, status: 0 };
  /** Every poll waits this long before answering (slow network). */
  slowMs = 0;
  /** The next poll answers its updates twice (a duplicate delivery). */
  duplicateNext = false;
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

  /** Queues an inbound message for this key; returns its update id. */
  push(key: string, message: Record<string, unknown>): number {
    const id = this.nextId++;
    this.updates.set(key, [...(this.updates.get(key) ?? []), { update_id: id, message: { chat_id: "chat-1", message_id: `m${id}`, ...message } }]);
    for (const w of this.waiters.get(key) ?? []) w();
    this.waiters.set(key, []);
    return id;
  }

  text(key: string, text: string): number {
    return this.push(key, { type: "text", text });
  }

  sentTexts(key?: string): string[] {
    return this.sent.filter((s) => !key || s.key === key).map((s) => String(s.body.text));
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
      if ((this.openPolls.get(key) ?? 0) > 0) return this.json(res, 409, { error: { code: 409, message: "Conflict: another poller" } });
      this.openPolls.set(key, (this.openPolls.get(key) ?? 0) + 1);
      this.maxConcurrentPolls = Math.max(this.maxConcurrentPolls, this.openPolls.get(key) ?? 0);
      const offset = url.searchParams.get("offset");
      this.polls.push({ key, offset });
      try {
        if (this.slowMs) await new Promise((r) => setTimeout(r, this.slowMs));
        const pending = () => (this.updates.get(key) ?? []).filter((u) => offset === null || u.update_id >= Number(offset));
        // Acknowledge: everything before the offset is gone for good.
        if (offset !== null) this.updates.set(key, pending());
        const timeoutS = Number(url.searchParams.get("timeout") ?? 0);
        if (!pending().length && timeoutS > 0) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, Math.min(timeoutS * 1000, 2000));
            this.waiters.set(key, [...(this.waiters.get(key) ?? []), () => (clearTimeout(t), resolve())]);
            req.once("close", () => (clearTimeout(t), resolve()));
          });
        }
        let list = pending().slice(0, Number(url.searchParams.get("limit") ?? 10));
        if (this.duplicateNext && list.length) {
          list = [...list, ...list];
          this.duplicateNext = false;
        }
        if (!res.destroyed) this.json(res, 200, { ok: true, result: list });
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
      if (String(body.text ?? "").length > 4096) return this.json(res, 400, { error: { code: 100, message: "text too long" } });
      this.sent.push({ key, body });
      return this.json(res, 200, { message_id: `out-${this.sent.length}` });
    }
    const media = /^\/media\/(.+)$/.exec(url.pathname);
    if (req.method === "GET" && media) {
      const m = this.media.get(decodeURIComponent(media[1]));
      if (!m) return this.json(res, 404, { error: { code: 404 } });
      if ("url" in m) return this.json(res, 200, { url: `${this.base}/download/${encodeURIComponent(media[1])}`, mime_type: m.type });
      res.writeHead(200, { "content-type": m.type, "content-length": String(m.bytes.length) });
      return void res.end(m.bytes);
    }
    const dl = /^\/download\/(.+)$/.exec(url.pathname);
    if (req.method === "GET" && dl) {
      const m = this.media.get(decodeURIComponent(dl[1]));
      if (!m) return this.json(res, 404, {});
      res.writeHead(200, { "content-type": m.type });
      return void res.end(m.bytes);
    }
    if (req.method === "POST" && url.pathname === "/media") {
      await this.body(req);
      return this.json(res, 200, { media_id: `up-${this.media.size + 1}` });
    }
    if (req.method === "POST" && url.pathname === "/statuses") {
      this.statuses.push(JSON.parse((await this.body(req)).toString("utf8") || "{}"));
      return this.json(res, 200, { ok: true });
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
