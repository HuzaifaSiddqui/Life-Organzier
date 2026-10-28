/**
 * Reading WhatsApp Agent payloads whose exact shape is not documented. The parser is tolerant on purpose: it
 * looks for the update id, message kind, text, media and chat reference under the names the community
 * implementation uses and a few likely alternatives. The probe (scripts/whatsapp-agent-probe.ts) records the
 * real shapes; tighten these once docs/whatsapp-agent-findings.md has them.
 */

type Json = unknown;
type Obj = Record<string, Json>;
const isObj = (v: Json): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export type AgentMedia = { id: string; mimeType: string | null; size: number | null; duration: number | null; fileName: string | null };
export type AgentKind = "text" | "voice" | "image" | "document" | "other";
export type AgentUpdate = {
  id: string;
  kind: AgentKind;
  text: string | null;
  media: AgentMedia | null;
  chatRef: string | null;
  /** For read receipts. */
  messageId: string | null;
};

/** Field names and value types only (for the probe and for logs). */
export function shape(value: Json, depth = 0): Json {
  if (depth > 8) return "…";
  if (value === null) return "null";
  if (Array.isArray(value)) return { array: value.length, items: value.slice(0, 3).map((v) => shape(v, depth + 1)) };
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, depth + 1)]));
  if (typeof value === "string") return `string(${value.length})`;
  return typeof value;
}

/** The list of updates inside a /updates response, wherever it is. */
export function updatesOf(json: Json): Json[] {
  if (Array.isArray(json)) return json;
  if (isObj(json)) for (const k of ["result", "updates", "data", "items", "messages"]) if (Array.isArray(json[k])) return json[k] as Json[];
  return [];
}

export function updateIdOf(u: Json): string | null {
  if (!isObj(u)) return null;
  for (const k of ["update_id", "updateId", "id", "offset"]) if (typeof u[k] === "number" || typeof u[k] === "string") return String(u[k]);
  return null;
}

/** The offset that acknowledges this update: id + 1 for numeric ids (Telegram-style), else the id itself. Unverified. */
export function nextOffset(updateId: string): string {
  return /^\d+$/.test(updateId) ? (BigInt(updateId) + 1n).toString() : updateId;
}

const MEDIA_KEYS: Array<[string, AgentKind]> = [
  ["voice", "voice"],
  ["audio", "voice"],
  ["image", "image"],
  ["photo", "image"],
  ["document", "document"],
  ["file", "document"],
  ["video", "other"],
  ["sticker", "other"],
];

/** The message object: `message`, `msg` or the update itself. */
function messageOf(u: Obj): Obj {
  for (const k of ["message", "msg", "data"]) if (isObj(u[k])) return u[k] as Obj;
  return u;
}

function str(o: Obj, ...keys: string[]): string | null {
  for (const k of keys) if (typeof o[k] === "string" || typeof o[k] === "number") return String(o[k]);
  return null;
}
function num(o: Obj, ...keys: string[]): number | null {
  for (const k of keys) if (typeof o[k] === "number") return o[k] as number;
  return null;
}

function mediaFrom(o: Obj): AgentMedia | null {
  const id = str(o, "media_id", "mediaId", "file_id", "fileId", "id");
  if (!id) return null;
  return {
    id,
    mimeType: str(o, "mime_type", "mimeType", "mimetype", "content_type", "contentType"),
    size: num(o, "file_size", "fileSize", "size", "bytes"),
    duration: num(o, "duration", "seconds"),
    fileName: str(o, "file_name", "fileName", "filename", "name"),
  };
}

function kindFromMime(mime: string | null): AgentKind | null {
  if (!mime) return null;
  if (mime.startsWith("audio/")) return "voice";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("application/") || mime.startsWith("text/")) return "document";
  return null;
}

/** One update in our own terms; null when it has no id (it can't be acknowledged or de-duplicated). */
export function normalizeUpdate(u: Json): AgentUpdate | null {
  const id = updateIdOf(u);
  if (!id || !isObj(u)) return null;
  const m = messageOf(u);
  let media: AgentMedia | null = null;
  let kind: AgentKind | null = null;
  for (const [key, k] of MEDIA_KEYS) {
    if (isObj(m[key])) {
      media = mediaFrom(m[key] as Obj);
      kind = k;
      break;
    }
  }
  if (!media && (m.media_id || m.mediaId || m.file_id)) {
    media = mediaFrom(m);
    kind = kindFromMime(media?.mimeType ?? null) ?? "other";
  }
  if (media && kind === "document") kind = kindFromMime(media.mimeType) === "image" ? "image" : "document";
  const typeName = str(m, "type", "message_type", "messageType");
  if (!kind && typeName && /voice|audio|ptt/i.test(typeName)) kind = "voice";
  const rawText = isObj(m.text) ? str(m.text as Obj, "body", "text") : str(m, "text", "body", "caption");
  if (!kind) kind = rawText !== null ? "text" : "other";
  const chat = isObj(m.chat) ? str(m.chat as Obj, "id") : str(m, "chat_id", "chatId", "conversation_id", "conversationId", "thread_id");
  const chatTop = chat ?? (isObj(u.chat) ? str(u.chat as Obj, "id") : str(u, "chat_id", "chatId"));
  return { id, kind, text: rawText, media, chatRef: chatTop, messageId: str(m, "message_id", "messageId") ?? (m !== u ? str(m, "id") : null) };
}
