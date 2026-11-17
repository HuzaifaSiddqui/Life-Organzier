import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { enqueueUnregister, flushUnregisterQueue, withoutToken, type PendingUnregister } from "../utils/pushQueue";
import { apiPost } from "./api";
import { classifyFailure } from "./checkins";
import { getDeviceId } from "./device";
import { scheduleReminderSync } from "./reminders";
import { syncNow } from "./syncEngine";
import { openAppScreen } from "../navigation/navigationRef";
import { noticeTarget } from "../utils/collab";

/**
 * P2: changes made elsewhere (WhatsApp, the desktop, another phone) reach this phone straight away, so its alarms are
 * re-planned without opening the app. Two ways, the token decides on the server (push/pushRules.ts):
 * - Firebase Cloud Messaging (default; needs mobile/google-services.json): the device token is registered and the
 *   server sends data-only pushes; the background task (services/notificationActions.ts) syncs, re-plans and shows
 *   "Added from WhatsApp" itself.
 * - Expo push, when the app config has an EAS projectId (docs/push-setup.md).
 * The token is never logged.
 */

const TOKEN_KEY = "life-organizer:push-token";
/** Tokens still to unregister after sign-out (survives restarts and offline periods). */
const QUEUE_KEY = "life-organizer:push-unregister-queue";

async function readQueue(): Promise<PendingUnregister[]> {
  try {
    const list = JSON.parse((await AsyncStorage.getItem(QUEUE_KEY)) ?? "[]") as PendingUnregister[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function writeQueue(queue: PendingUnregister[]): Promise<void> {
  try {
    if (queue.length) await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    else await AsyncStorage.removeItem(QUEUE_KEY);
  } catch {
    // storage unavailable: the server drops dead tokens when Expo reports them
  }
}

function projectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? null;
}

/** Registers this phone's Expo push token with the server. Only when notifications are already allowed; never prompts. */
export async function registerForPush(): Promise<void> {
  try {
    if (!(await Notifications.getPermissionsAsync()).granted) return;
    const id = projectId();
    // No EAS project: this phone's Firebase Cloud Messaging token (Android, google-services.json in the build).
    const getToken = async () =>
      id
        ? (await Notifications.getExpoPushTokenAsync({ projectId: id })).data
        : Platform.OS === "android"
          ? String((await Notifications.getDevicePushTokenAsync()).data)
          : null;
    // Google Play services can hang without network; give up and try again on the next start.
    const token = await Promise.race([getToken(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("token timeout")), 20000))]);
    if (!token) return;
    await writeQueue(withoutToken(await readQueue(), token)); // signed back in: a pending unregister must not undo this
    await apiPost("/push/register", { token, platform: Platform.OS === "ios" ? "ios" : "android", deviceId: await getDeviceId() });
    await AsyncStorage.setItem(TOKEN_KEY, token);
    console.info(`Push: registered (${id ? "expo" : "fcm"})`);
  } catch (error) {
    console.warn("Push registration failed:", error instanceof Error ? error.message : "unknown error");
  }
}

/**
 * Sign out: forget the token here at once and queue its removal on the server, which is retried
 * (on app start and when the app comes back to the foreground) until it succeeds. Never throws.
 */
export async function unregisterPush(): Promise<void> {
  try {
    const token = await AsyncStorage.getItem(TOKEN_KEY);
    await AsyncStorage.removeItem(TOKEN_KEY);
    if (!token) return;
    const item: PendingUnregister = { token, deviceId: await getDeviceId(), respondedAt: new Date().toISOString() };
    await writeQueue(enqueueUnregister(await readQueue(), item));
    await flushPushQueue();
  } catch {
    // storage unavailable
  }
}

let flushing: Promise<void> | null = null;

/** Sends queued unregisters (no login needed: the server checks token + device id). Never throws. */
export function flushPushQueue(): Promise<void> {
  flushing ??= (async () => {
    try {
      const queue = await readQueue();
      if (!queue.length) return;
      const remaining = await flushUnregisterQueue(queue, (q) => apiPost("/push/unregister-device", { token: q.token, deviceId: q.deviceId }).then(() => undefined), classifyFailure);
      // Re-read: during the flush a sign-in may have cancelled an entry, or a sign-out added one.
      const now = await readQueue();
      const added = now.filter((q) => !queue.some((o) => o.token === q.token));
      await writeQueue([...remaining.filter((r) => now.some((q) => q.token === r.token)), ...added]);
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/**
 * A "sync" push received in the foreground, or tapped, pulls changes and re-plans local alarms. A "collab" push
 * (task collaboration: a request, a shared task card, an answer, progress) pulls too; tapping it opens the task, the
 * card to answer (an invitation or a change), or People & sharing.
 */
export function startPushListeners(): () => void {
  const onData = (data: unknown, tapped: boolean) => {
    const type = (data as { type?: string } | null)?.type;
    if (type === "sync" || type === "collab") void syncNow().then(() => scheduleReminderSync());
    if (type === "collab" && tapped) {
      // The task itself when I have a copy, the card to answer for an invitation, else People & sharing.
      const d = data as { kind?: string; sharedTaskId?: string | null; taskId?: string | null };
      const target = noticeTarget({ kind: d.kind ?? "", sharedTaskId: d.sharedTaskId ?? null, taskId: d.taskId ?? null, pending: d.kind === "TASK_INVITE" || d.kind === "TASK_CHANGED" });
      openAppScreen(target.screen, target.params);
    }
  };
  const received = Notifications.addNotificationReceivedListener((n) => onData(n.request.content.data, false));
  const tapped = Notifications.addNotificationResponseReceivedListener((r) => onData(r.notification.request.content.data, true));
  return () => {
    received.remove();
    tapped.remove();
  };
}
