import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { dictionaries, type Language, type StringKey } from "../i18n/strings";
import { auth } from "../lib/firebase";
import { apiGet, apiPatch, apiPost } from "./api";
import { answerCheckin, showCheckinSheet, type CheckinResponse, type PlannedCheckin } from "./checkins";

/**
 * Offline-first reminders (FR-RN-001/002): the server computes an escalating, quiet-hours-aware
 * plan; the device schedules it as OS notifications so reminders fire without internet and even
 * when the app is closed. Actions (Done / Snooze / Open) feed adaptive reminder learning.
 */

type PlannedReminder = {
  id: string;
  taskId: string | null;
  routineOccurrenceId: string | null;
  fireAt: string;
  level: "gentle" | "normal" | "urgent" | "critical";
  title: string;
  body: string;
  prominent: boolean;
};

type PlanResponse = {
  reminders: PlannedReminder[];
  /** FR-RN-004 start & completion check-ins (scheduled after reminders, within the same cap). */
  checkins?: PlannedCheckin[];
  settings: { method: "APP" | "SOUND" | "VIBRATION" | "SOUND_VIBRATION"; devices: string; dndUntil: string | null; frequency: string };
};

const PREFIX = "lo:";
/** Below iOS's 64 pending-notification cap, leaving room for snoozes. */
const MAX_LOCAL_REMINDERS = 60;
const CATEGORY_TASK = "lo-task";
const CATEGORY_ROUTINE = "lo-routine";
const CATEGORY_CHECKIN_START = "lo-checkin-start";
const CATEGORY_CHECKIN_DONE = "lo-checkin-done";
const HANDLED_KEY = "life-organizer:handled-notification-response";
let configured = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

const CHANNELS: Record<PlanResponse["settings"]["method"], { id: string; name: string; sound: boolean; vibrate: boolean }> = {
  SOUND_VIBRATION: { id: "lo-sound-vibrate", name: "Reminders (sound + vibration)", sound: true, vibrate: true },
  SOUND: { id: "lo-sound", name: "Reminders (sound only)", sound: true, vibrate: false },
  VIBRATION: { id: "lo-vibrate", name: "Reminders (vibration only)", sound: false, vibrate: true },
  APP: { id: "lo-silent", name: "Reminders (silent)", sound: false, vibrate: false },
};

export async function configureReminders(): Promise<void> {
  if (configured) return;
  configured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  if (Platform.OS === "android") {
    for (const c of Object.values(CHANNELS)) {
      await Notifications.setNotificationChannelAsync(c.id, {
        name: c.name,
        importance: c.sound || c.vibrate ? Notifications.AndroidImportance.MAX : Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: c.vibrate ? [0, 250, 200, 250] : [0],
        enableVibrate: c.vibrate,
        // Omitting `sound` uses the system default; null makes the channel silent.
        ...(c.sound ? {} : { sound: null }),
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
    }
  }
  await registerCategories();
}

async function uiLanguage(): Promise<Language> {
  try {
    return (await AsyncStorage.getItem("ui.language")) === "ur" ? "ur" : "en";
  } catch {
    return "en";
  }
}

/**
 * Action buttons. Every action opens the app, so its JS runs even when the app was closed (no
 * background task handler). Check-in labels follow the UI language and are re-registered on each plan sync.
 */
async function registerCategories(): Promise<void> {
  const lang = await uiLanguage();
  const t = (k: StringKey) => dictionaries[lang][k] ?? dictionaries.en[k];
  const open = { opensAppToForeground: true };
  await Notifications.setNotificationCategoryAsync(CATEGORY_TASK, [
    { identifier: "DONE", buttonTitle: "Mark done", options: open },
    { identifier: "SNOOZE", buttonTitle: "Snooze 15 min", options: open },
    { identifier: "OPEN", buttonTitle: "View details", options: open },
  ]);
  await Notifications.setNotificationCategoryAsync(CATEGORY_ROUTINE, [
    { identifier: "DONE", buttonTitle: "Done", options: open },
    { identifier: "OPEN", buttonTitle: "Open", options: open },
  ]);
  await Notifications.setNotificationCategoryAsync(CATEGORY_CHECKIN_START, [
    { identifier: "STARTED", buttonTitle: t("checkin.started"), options: open },
    { identifier: "NOT_TODAY", buttonTitle: t("checkin.notToday"), options: open },
  ]);
  // Android shows at most 3 actions; completion uses exactly 3.
  await Notifications.setNotificationCategoryAsync(CATEGORY_CHECKIN_DONE, [
    { identifier: "DONE", buttonTitle: t("checkin.done"), options: open },
    { identifier: "PLUS_30", buttonTitle: t("checkin.plus30"), options: open },
    { identifier: "UPDATE", buttonTitle: t("checkin.update"), options: open },
  ]);
}

type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];
let lastChannel: Channel = CHANNELS.SOUND_VIBRATION;

/** Schedules one check-in notification (from the plan, or the "next" returned by the respond endpoint). */
export async function scheduleCheckin(c: PlannedCheckin, channel: Channel = lastChannel): Promise<boolean> {
  const date = new Date(c.fireAt);
  if (date.getTime() <= Date.now() + 5000) return false;
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: `${PREFIX}c:${c.id}`,
      content: {
        title: c.title,
        body: c.body,
        sound: channel.sound,
        categoryIdentifier: c.category === "START" ? CATEGORY_CHECKIN_START : CATEGORY_CHECKIN_DONE,
        data: { kind: "lo-checkin", checkinId: c.id, taskId: c.taskId, category: c.category },
        ...(Platform.OS === "android" ? { priority: Notifications.AndroidNotificationPriority.HIGH } : {}),
      },
      trigger:
        Platform.OS === "android"
          ? { type: Notifications.SchedulableTriggerInputTypes.DATE, date, channelId: channel.id }
          : { type: Notifications.SchedulableTriggerInputTypes.DATE, date },
    });
    return true;
  } catch (error) {
    console.warn("Could not schedule check-in", error);
    return false;
  }
}

export async function ensureNotificationPermissions(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

async function cancelOurs(): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(
    scheduled.filter((n) => n.identifier.startsWith(PREFIX)).map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier)),
  );
}

/** Downloads the reminder plan and (re)schedules local notifications. Keeps old ones when offline. */
export async function syncReminders(): Promise<number | null> {
  if (!auth.currentUser) return null;
  let plan: PlanResponse;
  try {
    plan = await apiGet<PlanResponse>("/reminders/plan?days=7");
  } catch {
    return null;
  }
  await configureReminders();
  if (!(await ensureNotificationPermissions())) return 0;
  await cancelOurs();
  if (plan.settings.devices === "DESKTOP" || plan.settings.devices === "WHATSAPP") return 0;
  const channel = CHANNELS[plan.settings.method] ?? CHANNELS.SOUND_VIBRATION;
  lastChannel = channel;
  await registerCategories();
  // iOS keeps at most 64 pending local notifications (and silently drops the rest). Keep the
  // soonest ones; the plan is re-synced on app open and after every change, so later reminders get
  // scheduled before they're due.
  const upcoming = plan.reminders
    .filter((r) => new Date(r.fireAt).getTime() > Date.now() + 5000)
    .sort((a, b) => new Date(a.fireAt).getTime() - new Date(b.fireAt).getTime());
  const batch = upcoming.slice(0, MAX_LOCAL_REMINDERS);
  if (upcoming.length > batch.length) {
    console.info(`Reminders: scheduled ${batch.length}, skipped ${upcoming.length - batch.length} later ones (local notification limit)`);
  }
  let count = 0;
  for (const r of batch) {
    const date = new Date(r.fireAt);
    try {
      await Notifications.scheduleNotificationAsync({
        identifier: `${PREFIX}${r.id}`,
        content: {
          title: r.title,
          body: r.body,
          sound: channel.sound,
          categoryIdentifier: r.taskId ? CATEGORY_TASK : CATEGORY_ROUTINE,
          data: { taskId: r.taskId, routineOccurrenceId: r.routineOccurrenceId, fireAt: r.fireAt, level: r.level, kind: "lo-reminder" },
          ...(Platform.OS === "android"
            ? { priority: r.prominent ? Notifications.AndroidNotificationPriority.MAX : Notifications.AndroidNotificationPriority.HIGH }
            : {}),
        },
        trigger:
          Platform.OS === "android"
            ? { type: Notifications.SchedulableTriggerInputTypes.DATE, date, channelId: channel.id }
            : { type: Notifications.SchedulableTriggerInputTypes.DATE, date },
      });
      count += 1;
    } catch (error) {
      console.warn("Could not schedule reminder", error);
    }
  }
  // Check-ins fill the remaining slots, soonest first. Re-scheduling everything from the plan also drops
  // check-ins the server cancelled (rescheduled or finished tasks).
  const checkins = (plan.checkins ?? [])
    .filter((c) => new Date(c.fireAt).getTime() > Date.now() + 5000)
    .sort((a, b) => new Date(a.fireAt).getTime() - new Date(b.fireAt).getTime());
  const room = Math.max(0, MAX_LOCAL_REMINDERS - count);
  for (const c of checkins.slice(0, room)) if (await scheduleCheckin(c, channel)) count += 1;
  if (checkins.length > room) console.info(`Check-ins: skipped ${checkins.length - room} later ones (local notification limit)`);
  return count;
}

/** Debounced re-plan after task/routine/settings changes. */
export function scheduleReminderSync(delayMs = 1500): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncReminders();
  }, delayMs);
}

export type ReminderOpenTarget = { taskId: string | null; routineOccurrenceId: string | null };

/** Answers a check-in from a notification action and shows the result in the app. */
async function handleCheckinAction(data: { checkinId?: string; taskId?: string | null; category?: string }, action: string, title: string, body: string): Promise<void> {
  const checkinId = data.checkinId;
  const taskId = data.taskId ?? null;
  if (!checkinId || !taskId) return;
  const direct = ["STARTED", "NOT_TODAY", "DONE", "PLUS_30"];
  if (!direct.includes(action)) {
    // Plain tap or "Update…": open the sheet; the user answers there.
    showCheckinSheet({ mode: data.category === "START" ? "start" : "update", checkinId, taskId, title, body });
    return;
  }
  const response = action as CheckinResponse;
  try {
    const result = await answerCheckin(checkinId, taskId, response);
    if (result?.next) await scheduleCheckin(result.next);
    showCheckinSheet({ mode: "result", taskId, title, result, response });
  } catch (error) {
    console.warn("Could not answer check-in", error);
    showCheckinSheet({ mode: "result", taskId, title, result: null, response });
  }
}

async function handleResponse(response: Notifications.NotificationResponse, onOpen: (target: ReminderOpenTarget) => void): Promise<void> {
  const content = response.notification.request.content;
  const data = (content.data ?? {}) as { taskId?: string | null; routineOccurrenceId?: string | null; fireAt?: string; kind?: string; checkinId?: string; category?: string };
  const action = response.actionIdentifier;
  if (data.kind === "lo-checkin") {
    await handleCheckinAction(data, action, content.title ?? "", content.body ?? "");
    return;
  }
  if (data.kind !== "lo-reminder") return;
  const target = { taskId: data.taskId ?? null, routineOccurrenceId: data.routineOccurrenceId ?? null };
  if (action === "DONE") {
    try {
      if (target.taskId) {
        const { updateTask } = await import("./tasksApi");
        await updateTask(target.taskId, { status: "COMPLETED" });
      } else if (target.routineOccurrenceId) {
        await apiPatch(`/routines/occurrences/${target.routineOccurrenceId}`, { status: "COMPLETED", confirmMandatory: true });
      }
    } catch (error) {
      console.warn("Could not complete from notification", error);
    }
  } else if (action === "SNOOZE") {
    await Notifications.scheduleNotificationAsync({
      identifier: `${PREFIX}snooze:${Date.now()}`,
      content: { title: content.title ?? "Reminder", body: content.body ?? "", data: content.data, categoryIdentifier: content.categoryIdentifier ?? CATEGORY_TASK },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 15 * 60 },
    });
  } else {
    onOpen(target);
  }
  const mapped = action === "DONE" ? "DONE" : action === "SNOOZE" ? "SNOOZE" : "OPEN";
  apiPost("/reminders/action", { taskId: target.taskId, fireAt: data.fireAt ?? null, action: mapped }).catch(() => undefined);
}

/** A response is handled once, even though the OS reports the launching tap again on every later start. */
async function claimResponse(r: Notifications.NotificationResponse): Promise<boolean> {
  const key = `${r.notification.request.identifier}|${r.actionIdentifier}|${r.notification.date}`;
  try {
    if ((await AsyncStorage.getItem(HANDLED_KEY)) === key) return false;
    await AsyncStorage.setItem(HANDLED_KEY, key);
  } catch {
    // storage unavailable: handle it rather than risk losing the tap
  }
  return true;
}

/**
 * Listens for notification taps/actions, including the one that launched the app from a cold start
 * (getLastNotificationResponseAsync), so a tap that opens the app is never lost.
 */
export function startReminderResponses(onOpen: (target: ReminderOpenTarget) => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((r) => {
    void claimResponse(r).then(async (fresh) => {
      if (fresh) await handleResponse(r, onOpen);
    });
  });
  void Notifications.getLastNotificationResponseAsync().then((r) => {
    if (r) void claimResponse(r).then(async (fresh) => {
      if (fresh) await handleResponse(r, onOpen);
    });
  });
  return () => sub.remove();
}

/** Clears every scheduled reminder (sign out). */
export async function clearAllReminders(): Promise<void> {
  await cancelOurs();
}
