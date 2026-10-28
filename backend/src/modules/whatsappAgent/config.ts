/**
 * WhatsApp Agent flags and limits (docs/whatsapp-agent.md). Everything is on by default: a Pro user pastes their
 * agent's key in the app and the server does the rest. The variables are kill switches ("off").
 * The limits come from a community implementation, not Meta's documentation (see docs/whatsapp-agent-findings.md).
 */

export const agentEnabled = (): boolean => process.env.WHATSAPP_AGENT !== "off";
/** Voice notes (transcribed by STT_PROVIDER, local whisper.cpp by default). */
export const agentVoiceEnabled = (): boolean => agentEnabled() && process.env.WHATSAPP_VOICE !== "off";
/** Reminders on WhatsApp. */
export const agentRemindersEnabled = (): boolean => agentEnabled() && process.env.WHATSAPP_AGENT_REMINDERS !== "off";

export const agentBaseUrl = (): string => (process.env.WHATSAPP_AGENT_BASE_URL || "https://api.whatsapp.com/agent/v1").replace(/\/$/, "");

/** Requests per minute, per key (unverified). */
export const PER_MINUTE = { messages: 12, statuses: 12, mediaGet: 12, mediaUpload: 12, polls: 15 } as const;
/** Text soft limit; the hard limit is 4096. Longer replies are split. */
export const TEXT_LIMIT = 4000;
/** Long-poll hold time in seconds. */
export const POLL_TIMEOUT_S = 25;
export const POLL_LIMIT = 10;

/** Files we read: the same types the app's Documents screen accepts, same 10 MB cap. */
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_TYPES: Record<string, string> = {
  "application/pdf": "whatsapp.pdf",
  "image/jpeg": "whatsapp.jpg",
  "image/png": "whatsapp.png",
  "image/webp": "whatsapp.webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "whatsapp.docx",
};
/** Voice notes: at most 2 minutes and 5 MB. */
export const VOICE_MAX_BYTES = 5 * 1024 * 1024;
export const VOICE_MAX_SECONDS = 120;

/** Context window for numbered replies, open questions and the router prompt. */
export const CONTEXT_TURNS = 8;
export const CONTEXT_TTL_MS = 30 * 60000;
/** About 4 characters a token. */
export const CONTEXT_MAX_TOKENS = 600;

export const PROCESSED_RETENTION_MS = 7 * 86400000;
