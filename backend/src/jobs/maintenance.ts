import { TaskStatus } from "@prisma/client";
import { prisma } from "../config/db.js";
import { getFirebaseAuth } from "../config/firebase.js";
import { computeDueAt } from "../lib/time.js";
import { expireCheckins } from "../modules/checkins/checkinService.js";
import { sendDueWhatsappReminders } from "../modules/whatsapp/whatsappService.js";

/** Permanent deletion & retention rules from the FRD (FR-TM-005, FR-MS-004, FR-AP-001). */
export async function runMaintenance(now = new Date()): Promise<void> {
  const purgedTasks = await prisma.task.deleteMany({ where: { status: TaskStatus.DELETED, deletedAt: { lt: new Date(now.getTime() - 86400000) } } });
  const purgedVersions = await prisma.taskVersion.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 90 * 86400000) } } });
  await prisma.reminderLog.deleteMany({ where: { fireAt: { lt: new Date(now.getTime() - 90 * 86400000) } } });
  await expireCheckins(now);
  await prisma.activityEvent.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 400 * 86400000) } } });

  const expired = await prisma.user.findMany({ where: { deletionRequestedAt: { lt: new Date(now.getTime() - 30 * 86400000) } } });
  for (const user of expired) {
    await prisma.user.delete({ where: { id: user.id } });
    try {
      await getFirebaseAuth().deleteUser(user.firebaseUid);
    } catch (error) {
      console.warn("Could not delete Firebase user", user.firebaseUid, error instanceof Error ? error.message : error);
    }
  }
  if (purgedTasks.count || purgedVersions.count || expired.length) {
    console.info(`Maintenance: purged ${purgedTasks.count} tasks, ${purgedVersions.count} versions, ${expired.length} accounts`);
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

export function startJobs(): () => void {
  const safe = (name: string, fn: () => Promise<unknown>) => () => {
    fn().catch((error) => console.warn(`Job ${name} failed:`, error instanceof Error ? error.message : error));
  };
  safe("backfill", backfillDueAt)();
  safe("maintenance", () => runMaintenance())();
  const hourly = setInterval(safe("maintenance", () => runMaintenance()), 3600000);
  const whatsapp = setInterval(safe("whatsapp-reminders", () => sendDueWhatsappReminders()), 5 * 60000);
  return () => {
    clearInterval(hourly);
    clearInterval(whatsapp);
  };
}
