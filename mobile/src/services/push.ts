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

/**
 * P2: a task added on WhatsApp reaches the phone straight away. The server sends a visible push
 * ("Added from WhatsApp", data {type: "sync"}); receiving or tapping it pulls the new task and re-plans
 * the local alarms. Needs an EAS projectId in the app config (see docs/push-setup.md); without one, push
 * is skipped and the next sync still picks the task up. The token is never logged.
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
    if (!id) {
      console.info("Push: no EAS projectId in the app config, skipping (see docs/push-setup.md)");
      return;
    }
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: id });
    await writeQueue(withoutToken(await readQueue(), token)); // signed back in: a pending unregister must not undo this
    await apiPost("/push/register", { token, platform: Platform.OS === "ios" ? "ios" : "android", deviceId: await getDeviceId() });
    await AsyncStorage.setItem(TOKEN_KEY, token);
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

/** A "sync" push received in the foreground, or tapped, pulls changes and re-plans local alarms. */
export function startPushListeners(): () => void {
  const onData = (data: unknown) => {
    if ((data as { type?: string } | null)?.type === "sync") void syncNow().then(() => scheduleReminderSync());
  };
  const received = Notifications.addNotificationReceivedListener((n) => onData(n.request.content.data));
  const tapped = Notifications.addNotificationResponseReceivedListener((r) => onData(r.notification.request.content.data));
  return () => {
    received.remove();
    tapped.remove();
  };
}
