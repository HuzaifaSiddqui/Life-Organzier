import { prisma } from "../../config/db.js";
import { agentEnabled, PROCESSED_RETENTION_MS } from "./config.js";
import { AgentConnectionManager, getAgentManager, setAgentManager } from "./connectionManager.js";
import { handleAgentUpdate } from "./inbound.js";
import { PgAdvisoryLock } from "./lock.js";
import { sendDueAgentReminders } from "./reminders.js";
import { secretConfigured } from "./secrets.js";

/** Starts the WhatsApp Agent pollers when WHATSAPP_AGENT=on (and the key secret is set). Null when off. */
export async function startWhatsappAgent(): Promise<AgentConnectionManager | null> {
  if (!agentEnabled()) return null;
  if (!secretConfigured()) {
    console.warn("WhatsApp Agent is on but WHATSAPP_KEY_SECRET is missing or not 32 bytes; not starting.");
    return null;
  }
  const manager = new AgentConnectionManager({ lock: new PgAdvisoryLock(), handler: (connection, update, io) => handleAgentUpdate(connection, update, io) });
  setAgentManager(manager);
  await manager.start();
  console.log("WhatsApp Agent: polling started");
  return manager;
}

export async function stopWhatsappAgent(): Promise<void> {
  const manager = getAgentManager();
  setAgentManager(null);
  await manager?.stop();
}

/** Every minute (jobs): reminders on WhatsApp. */
export async function runAgentJobs(now = new Date()): Promise<void> {
  await sendDueAgentReminders(getAgentManager(), now);
}

/** Hourly: dedupe rows older than 7 days (finished ones; unfinished ones are recovered by their poller first). */
export async function purgeProcessedUpdates(now = new Date()): Promise<number> {
  return (await prisma.whatsAppProcessedUpdate.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - PROCESSED_RETENTION_MS) } } })).count;
}
