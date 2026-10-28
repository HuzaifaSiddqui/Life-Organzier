import { apiDelete, apiGet, apiPatch, apiPost } from "./api";
import { scheduleReminderSync } from "./reminders";

/** WhatsApp Agent connection (server: /api/whatsapp-agent). The API key is sent once and never comes back. */
export type AgentStatus = {
  enabled: boolean;
  pro: boolean;
  connected: boolean;
  status: "PENDING" | "CONNECTED" | "NEEDS_RECONNECT" | "ERROR" | "DISABLED" | null;
  keyLast4: string | null;
  polling: boolean;
  lastPollAt: string | null;
  rateLimitedUntil: string | null;
  lastError: string | null;
  consentAt: string | null;
  reminders: { setting: "OFF" | "WHATSAPP" | "BOTH"; available: boolean };
  /** available: on for this server; ready: the server can transcribe right now. */
  voice: { setting: boolean; available: boolean; ready: boolean };
};

export function getAgentStatus(): Promise<AgentStatus> {
  return apiGet("/whatsapp-agent/status");
}

export async function connectAgent(apiKey: string): Promise<AgentStatus> {
  const status = await apiPost<AgentStatus>("/whatsapp-agent/connect", { apiKey, consent: true });
  scheduleReminderSync();
  return status;
}

export async function sendAgentTest(): Promise<void> {
  await apiPost("/whatsapp-agent/test", {});
}

export async function updateAgentSettings(patch: { reminders?: AgentStatus["reminders"]["setting"]; voice?: boolean }): Promise<AgentStatus> {
  const status = await apiPatch<AgentStatus>("/whatsapp-agent/settings", patch);
  // The phone leaves reminders to WhatsApp (or takes them back): re-plan now.
  if (patch.reminders) scheduleReminderSync();
  return status;
}

export async function disconnectAgent(): Promise<void> {
  await apiDelete("/whatsapp-agent");
  scheduleReminderSync();
}
