import { staleGuestCutoff } from "../modules/guest/guestRules.js";
import { TaskStatus } from "@prisma/client";
import { prisma } from "../config/db.js";
import { getFirebaseAuth } from "../config/firebase.js";
import { removeUserFiles } from "../lib/storage.js";
import { computeDueAt } from "../lib/time.js";
import { expireCheckins } from "../modules/checkins/checkinService.js";
import { sendMissedPhoneReminders } from "../modules/push/missedReminders.js";
import { checkPushReceipts } from "../modules/push/pushService.js";
import { purgeOldInbound, recoverStuckInbound } from "../modules/whatsapp/inbound.js";
import { purgeProcessedUpdates, runAgentJobs } from "../modules/whatsappAgent/index.js";
import { replanStaleWhatsappUsers, sendDueWhatsappReminders, sendUrgentWhatsappAlerts } from "../modules/whatsapp/whatsappService.js";

/** Permanent deletion & retention rules from the FRD (FR-TM-005, FR-MS-004, FR-AP-001). */
export async function runMaintenance(now = new Date()): Promise<void> {
  const purgedTasks = await prisma.task.deleteMany({ where: { status: TaskStatus.DELETED, deletedAt: { lt: new Date(now.getTime() - 86400000) } } });
  const purgedVersions = await prisma.taskVersion.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 90 * 86400000) } } });
  await prisma.reminderLog.deleteMany({ where: { fireAt: { lt: new Date(now.getTime() - 90 * 86400000) } } });
  await expireCheckins(now);
  await purgeOldInbound(now);
  await purgeProcessedUpdates(now);
  await prisma.activityEvent.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 400 * 86400000) } } });

  const expired = await prisma.user.findMany({ where: { deletionRequestedAt: { lt: new Date(now.getTime() - 30 * 86400000) } } });
  for (const user of expired) {
    await prisma.user.delete({ where: { id: user.id } });
    await removeUserFiles(user.id).catch((error: unknown) => console.warn("Could not delete user files", error));
    try {
      await getFirebaseAuth().deleteUser(user.firebaseUid);
    } catch (error) {
      console.warn("Could not delete Firebase user", user.firebaseUid, error instanceof Error ? error.message : error);
    }
  }
  // Guest mode (FR-OB-003): guests unused for 60 days (usually an uninstalled app) are deleted with their data.
  const cutoff = staleGuestCutoff(now);
  const staleGuests = await prisma.user.findMany({
    where: { isGuest: true, OR: [{ lastSeenAt: { lt: cutoff } }, { lastSeenAt: null, createdAt: { lt: cutoff } }] },
    select: { id: true, firebaseUid: true },
    take: 500,
  });
  for (const guest of staleGuests) {
    await prisma.user.delete({ where: { id: guest.id } });
    await removeUserFiles(guest.id).catch((error: unknown) => console.warn("Could not delete user files", error));
    await getFirebaseAuth()
      .deleteUser(guest.firebaseUid)
      .catch((error: unknown) => console.warn("Could not delete Firebase guest", error instanceof Error ? error.message : error));
  }
  if (purgedTasks.count || purgedVersions.count || expired.length || staleGuests.length) {
    console.info(`Maintenance: purged ${purgedTasks.count} tasks, ${purgedVersions.count} versions, ${expired.length} accounts, ${staleGuests.length} unused guests`);
  }
}

/** One-time backfill of absolute deadlines for tasks created before dueAt existed. */
export async function backfillDueAt(): Promise<void> {
  const tasks = await prisma.task.findMany({
    where: { dueDate: { not: null }, dueAt: null },
    select: { id: true, dueDate: true, dueTime: true, user: { select: { settings: { select: { timezone: true } } } } },
    take: 5000,
  });
  for (const t of tasks) {
    const dueAt = computeDueAt(t.dueDate, t.dueTime, t.user.settings?.timezone ?? "UTC");
    if (dueAt) await prisma.task.update({ where: { id: t.id }, data: { dueAt } });
  }
  if (tasks.length) console.info(`Backfilled deadlines for ${tasks.length} tasks`);
}

/** Every 5 minutes: lost inbound messages, fresh reminder plans for WhatsApp users, due reminders and snoozes, urgent alerts, push receipts. */
export async function runWhatsappJobs(now = new Date()): Promise<void> {
  await recoverStuckInbound(now);
  await replanStaleWhatsappUsers(now);
  await sendDueWhatsappReminders(now);
  await sendUrgentWhatsappAlerts(now);
  await checkPushReceipts(now.getTime());
}

/** Milliseconds until the next whole minute (0 exactly on one). */
export function msToNextMinute(now: number): number {
  return (60000 - (now % 60000)) % 60000;
}

export function startJobs(): () => void {
  const safe = (name: string, fn: () => Promise<unknown>) => () => {
    fn().catch((error) => console.warn(`Job ${name} failed:`, error instanceof Error ? error.message : error));
  };
  safe("backfill", backfillDueAt)();
  safe("maintenance", () => runMaintenance())();
  const hourly = setInterval(safe("maintenance", () => runMaintenance()), 3600000);
  const whatsapp = setInterval(safe("whatsapp", () => runWhatsappJobs()), 5 * 60000);
  // WhatsApp Agent reminders (does nothing unless WHATSAPP_AGENT and WHATSAPP_AGENT_REMINDERS are on). Reminders are
  // due on whole minutes, so the job runs 1 s after each minute starts (a 5:02 reminder goes at 5:02:01, not up to a
  // minute late as with a plain interval counted from the server's start).
  let agent: NodeJS.Timeout | null = null;
  const first = setTimeout(() => {
    const minute = () => {
      safe("whatsapp-agent", () => runAgentJobs())();
      // Reminders a phone missed (task changed elsewhere, app frozen): a visible push at fire time.
      safe("missed-reminders", () => sendMissedPhoneReminders())();
    };
    minute();
    agent = setInterval(minute, 60000);
  }, msToNextMinute(Date.now()) + 1000);
  return () => {
    clearInterval(hourly);
    clearInterval(whatsapp);
    clearTimeout(first);
    if (agent) clearInterval(agent);
  };
}
