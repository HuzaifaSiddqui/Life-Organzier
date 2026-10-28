import type { WhatsAppAgentConnection } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { ensureSettings } from "../../lib/http.js";
import { getStt, sttReady, usableTranscript, type Transcript } from "../../ai/stt.js";
import { handleAssistantMessage } from "../assistant/dialogue.js";
import type { ActionPayload } from "../assistant/types.js";
import { dropStaleQuestion, loadContext } from "../conversations/conversationContext.js";
import { processDocument } from "../documents/documentProcessing.js";
import { OcrBusyError } from "../documents/textExtraction.js";
import { logEvent } from "../events/eventService.js";
import { crisisResponse, detectCrisis } from "../mood/crisis.js";
import { formatReply, whatsappActions } from "../whatsapp/inbound.js";
import { MediaTooLargeError } from "./client.js";
import { CONTEXT_MAX_TOKENS, CONTEXT_TTL_MS, CONTEXT_TURNS, DOCUMENT_MAX_BYTES, DOCUMENT_TYPES, VOICE_MAX_BYTES, VOICE_MAX_SECONDS, agentVoiceEnabled } from "./config.js";
import type { HandlerIO } from "./connectionManager.js";
import type { AgentUpdate } from "./shapes.js";

/**
 * One inbound WhatsApp Agent message → the same assistant engine as the app and the Twilio number
 * (handleAssistantMessage, channel WHATSAPP_AGENT). Crisis detection runs first on any text, including a voice
 * transcript, before anything is stored. Replies are plain text; options are numbered exactly as the Twilio
 * path numbers them (formatReply / whatsappActions), and "1", "2" … answer them like a tap (same payloads).
 */

export const CHANNEL = "WHATSAPP_AGENT";
const DEVICE = "whatsapp-agent";

const COPY = {
  en: {
    empty: 'Send me a message like "Add assignment due Friday 3 PM" or "What\'s due today?"',
    proOnly: "WhatsApp is part of Life Organizer Pro. Upgrade in the app (Settings) to keep chatting here.",
    voiceOff: "Voice notes are off. Please type your message, or turn on voice notes in the app (Settings → WhatsApp).",
    voiceUnavailable: "I can't listen to voice notes on this server yet. Please type your message.",
    voiceTooLong: `That voice note is too long for me (over ${VOICE_MAX_SECONDS / 60} minutes). Please type it or send a shorter one.`,
    typeIt: "Sorry, I couldn't make that out. Could you type it?",
    heard: (t: string) => `I heard: "${t}"`,
    unsupported: "I can read photos (JPG, PNG, WebP), PDFs and Word files (DOCX) up to 10 MB. Please send one of those, or upload it in the app (Documents).",
    tooBig: "That file is over 10 MB. Please send a smaller one, or upload it in the app (Documents).",
    downloadFailed: "I couldn't download that file. Please send it again.",
    busy: "I'm reading other documents right now. Please send it again in a minute.",
    other: "I can read text, voice notes, photos, PDFs and Word files.",
  },
  // Roman Urdu: the agent replies in English or Roman Urdu only.
  ur: {
    proOnly: "WhatsApp Life Organizer Pro ka hissa hai. Yahan baat jaari rakhne ke liye app (Settings) mein Pro lein.",
    empty: 'Mujhe aisa message bhejein: "Friday 3 baje assignment" ya "Aaj kya due hai?"',
    voiceOff: "Voice notes band hain. Message type kar dein, ya app mein (Settings → WhatsApp) voice notes on kar lein.",
    voiceUnavailable: "Abhi main voice notes nahin sun sakta. Meherbani karke type kar dein.",
    voiceTooLong: `Yeh voice note bohat lamba hai (${VOICE_MAX_SECONDS / 60} minute se zyada). Type kar dein ya chhota bhejein.`,
    typeIt: "Maaf kijiye, samajh nahin aaya. Type kar dein?",
    heard: (t: string) => `Main ne suna: "${t}"`,
    unsupported: "Main photo (JPG, PNG, WebP), PDF aur Word (DOCX) file 10 MB tak parh sakta hoon. Inmein se koi bhejein, ya app mein (Documents) upload karein.",
    tooBig: "Yeh file 10 MB se bari hai. Chhoti file bhejein, ya app mein (Documents) upload karein.",
    downloadFailed: "File download nahin hui. Dobara bhej dein.",
    busy: "Abhi doosre documents parh raha hoon. Ek minute baad dobara bhejein.",
    other: "Main text, voice notes, photos, PDF aur Word files parh sakta hoon.",
  },
};
export const agentCopy = (language: string) => (language === "ur" ? COPY.ur : COPY.en);

/** Runs one turn through the engine with the context window, and replies with numbered options. */
async function engineTurn(
  user: Awaited<ReturnType<typeof loadUser>>["user"],
  settings: Awaited<ReturnType<typeof loadUser>>["settings"],
  text: string,
  io: HandlerIO,
  now: Date,
  lead?: string,
): Promise<void> {
  const window = await loadContext(user.id, CHANNEL, now, { maxTurns: CONTEXT_TURNS, ttlMs: CONTEXT_TTL_MS, maxTokens: CONTEXT_MAX_TOKENS });
  await dropStaleQuestion(user.id, CHANNEL, window);
  // A number or an exact label answers the previous reply's options (numbered as formatReply listed them).
  const actions = whatsappActions(window.actions);
  const n = /^\d$/.test(text) ? Number(text) : NaN;
  const picked = Number.isInteger(n) && n >= 1 && n <= actions.length ? actions[n - 1] : actions.find((a) => a.label.toLowerCase() === text.toLowerCase());
  const answer = await handleAssistantMessage({
    user,
    settings,
    deviceId: DEVICE,
    text: picked?.payload ? null : (picked?.text ?? text),
    payload: (picked?.payload as ActionPayload | undefined) ?? null,
    label: picked?.label ?? null,
    channel: CHANNEL,
    now,
    history: window.expired ? [] : window.turns,
  });
  const body = formatReply(answer.message.content, answer.message.actions ?? []);
  await io.reply(lead ? `${lead}\n\n${body}` : body);
}

async function loadUser(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const settings = await ensureSettings(userId);
  return { user, settings };
}

export async function handleAgentUpdate(connection: WhatsAppAgentConnection, update: AgentUpdate, io: HandlerIO, now = new Date()): Promise<void> {
  const { user, settings } = await loadUser(connection.userId);
  const c = agentCopy(settings.language);
  const text = (update.text ?? "").trim();

  // Safety first: crisis resources at once, nothing stored, no other processing (as on the Twilio number).
  if (text && detectCrisis(text)) {
    await io.reply(crisisResponse(settings.language));
    return;
  }
  // Pro only. A user who went back to Free gets this until the poller stops at the next rescan (within a minute).
  if (settings.tier !== "PRO") return void (await io.reply(c.proOnly));
  logEvent(user.id, "WHATSAPP_AGENT_RECEIVED", null, { kind: update.kind });

  if (update.kind === "voice") return handleVoice(user, settings, update, io, now);
  if (update.kind === "image" || update.kind === "document") return handleDocument(user, settings, update, io);
  if (update.kind === "other") return void (await io.reply(c.other));
  if (!text) return void (await io.reply(c.empty));
  await engineTurn(user, settings, text, io, now);
}

async function download(update: AgentUpdate, io: HandlerIO, max: number): Promise<{ bytes: Buffer; mimeType: string | null } | "too_big" | null> {
  if (!update.media) return null;
  if (update.media.size !== null && update.media.size > max) return "too_big";
  if (!(await io.limiter.acquire("mediaGet"))) return null;
  try {
    return await io.client.getMedia(update.media.id, max);
  } catch (error) {
    if (error instanceof MediaTooLargeError) return "too_big";
    return null;
  }
}

async function handleVoice(user: Awaited<ReturnType<typeof loadUser>>["user"], settings: Awaited<ReturnType<typeof loadUser>>["settings"], update: AgentUpdate, io: HandlerIO, now: Date): Promise<void> {
  const c = agentCopy(settings.language);
  if (!agentVoiceEnabled() || !settings.waAgentVoice) return void (await io.reply(c.voiceOff));
  const stt = getStt();
  if (!(await sttReady(stt)) || !stt) return void (await io.reply(c.voiceUnavailable));
  if (update.media?.duration && update.media.duration > VOICE_MAX_SECONDS) return void (await io.reply(c.voiceTooLong));
  const file = await download(update, io, VOICE_MAX_BYTES);
  if (file === "too_big") return void (await io.reply(c.voiceTooLong));
  if (!file) return void (await io.reply(c.downloadFailed));
  let transcript: Transcript | null = null;
  try {
    transcript = await stt.transcribe(file.bytes, file.mimeType ?? update.media?.mimeType ?? "audio/ogg", { languages: ["en", "ur"], timeoutMs: 60000 });
  } catch (error) {
    console.warn("WhatsApp Agent: transcription failed:", error instanceof Error ? error.message : "error");
  }
  logEvent(user.id, "WHATSAPP_AGENT_VOICE", null, { ok: usableTranscript(transcript), ms: transcript?.ms ?? null, provider: stt.name });
  if (!usableTranscript(transcript)) return void (await io.reply(c.typeIt));
  const heard = transcript.text.trim();
  // The transcript is text like any other: the crisis check runs on it first.
  if (detectCrisis(heard)) return void (await io.reply(crisisResponse(settings.language)));
  await engineTurn(user, settings, heard, io, now, c.heard(heard));
}

async function handleDocument(user: Awaited<ReturnType<typeof loadUser>>["user"], settings: Awaited<ReturnType<typeof loadUser>>["settings"], update: AgentUpdate, io: HandlerIO): Promise<void> {
  const c = agentCopy(settings.language);
  const declared = update.media?.mimeType?.split(";")[0].trim().toLowerCase() ?? null;
  if (declared && !DOCUMENT_TYPES[declared]) return void (await io.reply(c.unsupported));
  const file = await download(update, io, DOCUMENT_MAX_BYTES);
  if (file === "too_big") return void (await io.reply(c.tooBig));
  if (!file) return void (await io.reply(c.downloadFailed));
  const mimeType = declared ?? file.mimeType?.split(";")[0].trim().toLowerCase() ?? "";
  if (!DOCUMENT_TYPES[mimeType]) return void (await io.reply(c.unsupported));
  // The existing pipeline, unchanged and with all its gates. autoCreate is off: nothing from WhatsApp is created
  // until the user confirms the preview below.
  const result = await processDocument(user, settings, { buffer: file.bytes, fileName: update.media?.fileName ?? DOCUMENT_TYPES[mimeType], mimeType, docType: "OTHER", language: "eng", autoCreate: false }).catch((error: unknown) => {
    if (error instanceof OcrBusyError) return null;
    throw error;
  });
  if (!result) return void (await io.reply(c.busy));
  const answer = await handleAssistantMessage({
    user,
    settings,
    deviceId: DEVICE,
    payload: { type: "command", command: "document_add_items", args: { documentId: result.document.id } },
    label: settings.language === "ur" ? "Document bheja" : "Sent a document",
    channel: CHANNEL,
  });
  const warning = result.extracted.warning ? `${result.extracted.warning}\n\n` : "";
  await io.reply(warning + formatReply(answer.message.content, answer.message.actions ?? []));
}
