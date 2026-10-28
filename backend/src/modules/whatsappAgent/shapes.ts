/**
 * WhatsApp Agent payloads, as seen working against the real API (docs/whatsapp-agent-findings.md):
 *
 *   GET /updates → 200 { entry: [{ changes: [{ value: { messages: [Message, …] } }] }], next_offset: "<opaque>" }
 *                  204 (no body) when the long poll ends with nothing new
 *   Message      = WhatsApp Cloud API message: { id, from: "user:<id>", timestamp, type,
 *                  text?: { body }, image|audio|video|document|sticker?: { id, mime_type, caption?, filename?, voice? } }
 *
 * The offset is opaque: send back next_offset as it came. Messages carry their own ids (used to de-duplicate);
 * there is no per-update id.
 */

type Json = unknown;
type Obj = Record<string, Json>;
const isObj = (v: Json): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: Json): string | null => (typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : null);
const num = (v: Json): number | null => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);

export type AgentMedia = { id: string; mimeType: string | null; size: number | null; duration: number | null; fileName: string | null };
export type AgentKind = "text" | "voice" | "image" | "document" | "other";
export type AgentUpdate = {
  /** The message id (de-duplication key). */
  id: string;
  kind: AgentKind;
  /** Text body, or a media caption. */
  text: string | null;
  media: AgentMedia | null;
  /** Who sent it ("user:<id>"): the only recipient a reply can go to. */
  chatRef: string | null;
  /** For read receipts. */
  messageId: string | null;
};
export type UpdateBatch = { updates: AgentUpdate[]; nextOffset: string | null };

/** Field names and value types only (for the probe and for logs). */
export function shape(value: Json, depth = 0): Json {
  if (depth > 8) return "…";
  if (value === null) return "null";
  if (Array.isArray(value)) return { array: value.length, items: value.slice(0, 3).map((v) => shape(v, depth + 1)) };
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, depth + 1)]));
  if (typeof value === "string") return `string(${value.length})`;
  return typeof value;
}

/** The raw message objects inside a /updates response. */
export function rawMessages(json: Json): Json[] {
  if (!isObj(json)) return [];
  const out: Json[] = [];
  for (const entry of Array.isArray(json.entry) ? json.entry : []) {
    if (!isObj(entry)) continue;
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      const value = isObj(change) && isObj(change.value) ? change.value : null;
      if (value && Array.isArray(value.messages)) out.push(...value.messages);
    }
  }
  return out;
}

const MEDIA_KEYS = ["image", "audio", "video", "document", "sticker"] as const;

/** One message in our own terms; null without an id (it couldn't be de-duplicated). */
export function normalizeMessage(raw: Json): AgentUpdate | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  if (!id) return null;
  const type = str(raw.type) ?? "unknown";
  const mediaKey = MEDIA_KEYS.find((k) => isObj(raw[k]));
  const m = mediaKey ? (raw[mediaKey] as Obj) : null;
  const mediaId = m ? str(m.id) : str(raw.media_id);
  const media: AgentMedia | null = mediaId
    ? {
        id: mediaId,
        mimeType: str(m?.mime_type) ?? str(raw.mime_type),
        size: num(m?.file_size) ?? num(raw.file_size),
        duration: num(m?.duration),
        fileName: str(m?.filename) ?? str(raw.filename),
      }
    : null;
  const mime = media?.mimeType?.toLowerCase() ?? "";
  let kind: AgentKind;
  if (type === "text") kind = "text";
  else if (type === "audio" || mediaKey === "audio") kind = "voice"; // voice notes have audio.voice = true; other audio is read the same way
  else if (type === "image" || mediaKey === "image" || (mediaKey === "document" && mime.startsWith("image/"))) kind = "image";
  else if (type === "document" || mediaKey === "document") kind = "document";
  else kind = "other";
  const textObj = isObj(raw.text) ? raw.text : null;
  const text = str(textObj?.body) ?? str(raw.body) ?? str(m?.caption) ?? str(raw.caption);
  return { id, kind, text, media: kind === "text" ? null : media, chatRef: str(raw.from) ?? str(raw.sender), messageId: id };
}

/** A /updates body: its messages and the offset to send next time (null = keep the current one). */
export function parseUpdates(json: Json): UpdateBatch {
  return {
    updates: rawMessages(json)
      .map(normalizeMessage)
      .filter((u): u is AgentUpdate => u !== null),
    nextOffset: isObj(json) ? str(json.next_offset) : null,
  };
}
