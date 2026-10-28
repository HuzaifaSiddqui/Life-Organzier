/** Pure helpers for Settings → WhatsApp Agent (tested in utils/__tests__/whatsappAgent.test.ts). */

export type AgentChip = "connected" | "needsReconnect" | "error" | "rateLimited" | "notConnected";
export type ChipTone = "success" | "warning" | "danger" | "neutral";

type StatusLike = { status: string | null; rateLimitedUntil: string | null };

/** What the status chip says. Rate-limited wins while it lasts: the connection is fine, just paused. */
export function agentChip(s: StatusLike | null, now = Date.now()): AgentChip {
  if (!s || !s.status) return "notConnected";
  if (s.status === "NEEDS_RECONNECT") return "needsReconnect";
  if (s.status === "ERROR") return "error";
  if (s.status !== "CONNECTED") return "notConnected";
  if (s.rateLimitedUntil && Date.parse(s.rateLimitedUntil) > now) return "rateLimited";
  return "connected";
}

export const CHIP_TONE: Record<AgentChip, ChipTone> = { connected: "success", needsReconnect: "warning", error: "danger", rateLimited: "warning", notConnected: "neutral" };
export const CHIP_ICON: Record<AgentChip, "check" | "info" | "clock" | "lock"> = { connected: "check", needsReconnect: "info", error: "info", rateLimited: "clock", notConnected: "lock" };

/** Server error codes → copy keys (never the server's text). Unknown → generic. */
export function agentErrorKey(code: string | null, offline: boolean): string {
  if (offline) return "waAgent.err.offline";
  const known = ["INVALID_KEY", "NOT_CREATOR", "KEY_IN_USE", "RATE_LIMITED", "NOT_AVAILABLE", "UNREACHABLE", "REMINDERS_UNAVAILABLE", "VOICE_UNAVAILABLE", "NOT_CONNECTED"];
  return code && known.includes(code) ? `waAgent.err.${code}` : "waAgent.err.generic";
}

/** A pasted key: trimmed, no spaces or line breaks inside (copying from WhatsApp can add them). */
export function cleanKey(input: string): string {
  return input.replace(/\s+/g, "");
}

export function keyLooksValid(key: string): boolean {
  return key.length >= 8 && key.length <= 512;
}

/** "••••abcd": the only part of the key the app ever shows again. */
export function maskedKey(last4: string | null): string {
  return last4 ? `••••${last4}` : "";
}
