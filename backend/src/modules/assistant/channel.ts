/**
 * Where a turn came from. WHATSAPP is the Twilio number (FR-WA-001); WHATSAPP_AGENT is the user's own WhatsApp
 * Agent (behind WHATSAPP_AGENT=on, see docs/whatsapp-agent.md). Both are text-only: no buttons or cards, numbered
 * options instead, shorter lists.
 */
export type Channel = "APP" | "VOICE" | "WHATSAPP" | "WHATSAPP_AGENT";

/** A WhatsApp channel (Twilio or Agent): plain text, numbered options. */
export function isWhatsapp(channel: string): boolean {
  return channel === "WHATSAPP" || channel === "WHATSAPP_AGENT";
}
