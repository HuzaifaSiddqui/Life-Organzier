import { prisma } from "../../config/db.js";
import { instantLabel } from "../../lib/time.js";
import { planReminders } from "../reminders/reminderService.js";
import { remindersViaAgent } from "../whatsappAgent/service.js";
import { PHONE_CHANNELS, dueWindow, isExpoToken, missedOnPhone } from "./pushRules.js";
import { sendPushMessages, type PushMessage } from "./pushService.js";

/**
 * Reminders the phone missed. A phone schedules its own alarms from the reminder plan, so it reminds on time with no
 * network. But a task added or changed elsewhere (WhatsApp, the desktop, another phone) only reaches it through the
 * silent sync push, and phones whose battery saver freezes background apps may not run that until the app is opened.
 *
 * So every minute the server checks the task reminders that just came due: for each phone (FCM token) whose last plan
 * fetch is older than the task's last change, it sends the reminder as a visible notification, which Android shows
 * itself even while the app is frozen or swiped away (like a calendar or chat app). Phones that are up to date get
 * nothing from here, so nothing arrives twice. Read-only on reminder rows (the WhatsApp Agent job claims those).
 *
 * Routine reminders are left out: routines repeat, so the phone has them from an earlier plan.
 */

const SKIP = ["ACTED", "IGNORED", "SKIPPED"];
let lastRun: number | null = null;
// ponytail: per process, like the agent job; a restart may at worst repeat one minute's reminders on a stale phone.
const sent = new Map<string, number>();

/** Test hook. */
export function resetMissedReminderState(): void {
  lastRun = null;
  sent.clear();
}

export async function sendMissedPhoneReminders(now = new Date()): Promise<number> {
  const { from, to } = dueWindow(lastRun, now.getTime());
  lastRun = to;
  for (const [k, at] of sent) if (at < to - 3600000) sent.delete(k);

  const tokens = (
    await prisma.pushToken.findMany({
      where: { platform: "android", user: { settings: { notificationDevices: { in: ["ALL", "PHONE"] }, notificationFrequency: { not: "NONE" } } } },
      select: { token: true, userId: true, planSyncedAt: true },
    })
  ).filter((t) => !isExpoToken(t.token));
  const byUser = new Map<string, typeof tokens>();
  for (const t of tokens) byUser.set(t.userId, [...(byUser.get(t.userId) ?? []), t]);

  let count = 0;
  for (const [userId, phones] of byUser) {
    const oldest = phones.some((p) => !p.planSyncedAt) ? null : new Date(Math.min(...phones.map((p) => (p.planSyncedAt as Date).getTime())));
    // Nothing changed since every phone's last plan: they all have their alarms.
    if (oldest && (await prisma.task.count({ where: { userId, updatedAt: { gt: oldest } } })) === 0) continue;
    const settings = await prisma.userSettings.findUnique({ where: { userId } });
    if (!settings) continue;
    // WhatsApp instead of phone notifications: the phone is not meant to show these (the agent job pushes on failure).
    if (settings.waAgentReminders === "WHATSAPP" && (await remindersViaAgent(userId))) continue;
    // The reminder rows exist only once a plan was made after the change (by the desktop, WhatsApp or here).
    if (!settings.remindersPlannedAt || (await prisma.task.count({ where: { userId, updatedAt: { gt: settings.remindersPlannedAt } } })) > 0) {
      await planReminders(userId, settings, new Date(from));
    }
    const rows = await prisma.reminderLog.findMany({
      where: { userId, taskId: { not: null }, status: { notIn: SKIP }, fireAt: { gt: new Date(from), lte: new Date(to) } },
      orderBy: { fireAt: "asc" },
      take: 20,
    });
    const messages: PushMessage[] = [];
    for (const r of rows) {
      const task = await prisma.task.findFirst({ where: { id: r.taskId as string, userId, status: { in: ["PENDING", "IN_PROGRESS"] }, archived: false } });
      if (!task) continue;
      // A snooze made on WhatsApp is new to the phone too.
      const changedAt = r.status === "SNOOZED" && r.createdAt > task.updatedAt ? r.createdAt : task.updatedAt;
      for (const p of phones) {
        const key = `${p.token}|${task.id}|${r.fireAt.toISOString()}`;
        if (!missedOnPhone(p.planSyncedAt, changedAt) || sent.has(key)) continue;
        sent.set(key, to);
        messages.push({
          to: p.token,
          title: task.title,
          body: task.dueAt ? `Due ${instantLabel(task.dueAt, settings.timezone, now)}` : "Reminder",
          data: { kind: "lo-reminder", type: "reminder", taskId: task.id, fireAt: r.fireAt.toISOString() },
          notify: { channelId: PHONE_CHANNELS[settings.notificationMethod] ?? PHONE_CHANNELS.SOUND_VIBRATION, tag: `lo:${task.id}` },
        });
      }
    }
    if (messages.length) count += await sendPushMessages(messages);
  }
  return count;
}
