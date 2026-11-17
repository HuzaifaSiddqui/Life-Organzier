/**
 * Push rules (pure, tested in tests/pushRules.test.ts).
 * - Which token goes through which service: Expo push tokens ("ExponentPushToken[…]") through Expo, anything else is a
 *   Firebase Cloud Messaging device token, sent with firebase-admin (the phone registers that when the app has no EAS
 *   project; docs/push-setup.md).
 * - Which API requests change the user's data, so their other devices are told to sync (a silent push).
 * - How a message becomes an FCM data message: data only (strings), so the phone's background task always gets it,
 *   also when the app is closed, and shows a visible notification itself when there is a title.
 * - Missed reminders: when the phone can't have a reminder (missedOnPhone) it goes as a visible FCM notification.
 */

export function isExpoToken(token: string): boolean {
  return /^Expo(nent)?PushToken\[/.test(token);
}

/** Requests that change tasks, routines or what reminders depend on. GETs and the plain pull (`/sync` with nothing to push) don't. */
export function changesUserData(method: string, path: string, body: unknown): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  const p = path.replace(/\?.*$/, "");
  if (/^\/api\/sync\/?$/.test(p)) {
    const mutations = (body as { mutations?: unknown[] } | null)?.mutations;
    return Array.isArray(mutations) && mutations.length > 0;
  }
  return /^\/api\/(tasks|routines|assistant\/message|documents|settings|categories|checkins)(\/|$)/.test(p);
}

export type FcmData = Record<string, string>;

/** An FCM data payload: every value a string; the title / body travel as loTitle / loBody so the phone decides how to show them. */
export function fcmData(msg: { title?: string; body?: string; data?: Record<string, unknown> }): FcmData {
  const out: FcmData = {};
  for (const [k, v] of Object.entries(msg.data ?? {})) if (v !== undefined && v !== null) out[k] = typeof v === "string" ? v : JSON.stringify(v);
  // Not "title" / "body": expo-notifications would show those itself; the app's task shows them with its own look.
  if (msg.title) out.loTitle = msg.title;
  if (msg.body) out.loBody = msg.body;
  if (!out.type) out.type = "sync";
  return out;
}

/** firebase-admin error codes meaning the token is gone (uninstalled, signed out, expired). */
export function fcmTokenGone(code: string | undefined): boolean {
  return code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token" || code === "messaging/invalid-argument";
}

/** The phone's notification channel per reminder method (mobile/src/services/reminders.ts CHANNELS). */
export const PHONE_CHANNELS: Record<string, string> = { SOUND_VIBRATION: "lo-sound-vibrate", SOUND: "lo-sound", VIBRATION: "lo-vibrate", APP: "lo-silent" };

/**
 * A reminder the phone can't have scheduled itself: it last fetched its reminder plan before the task changed (or
 * never, on this install). Then the server sends the reminder as a visible push at fire time.
 */
export function missedOnPhone(planSyncedAt: Date | null, changedAt: Date): boolean {
  return !planSyncedAt || planSyncedAt.getTime() < changedAt.getTime();
}

/** Reminders due since the last run (at most 5 minutes back; 1 minute on the first run), so none is sent twice or lost. */
export function dueWindow(lastRun: number | null, now: number): { from: number; to: number } {
  return { from: Math.max(lastRun ?? now - 60000, now - 5 * 60000), to: now };
}

export type FcmMessage = {
  token: string;
  data: FcmData;
  notification?: { title: string; body: string };
  android: { priority: "high"; ttl: number; notification?: { channelId: string; tag: string; icon: string; color: string } };
};

/**
 * The firebase-admin message. Data-only by default (the app's background task decides). With `notify`, a visible
 * notification that Android shows itself, even while the app is frozen by a battery saver or swiped away: used for
 * reminders the phone missed. `tag` replaces an earlier one for the same reminder instead of stacking.
 */
export function fcmMessage(m: { to: string; title?: string; body?: string; data?: Record<string, unknown>; notify?: { channelId: string; tag: string } }): FcmMessage {
  if (!m.notify) return { token: m.to, data: fcmData(m), android: { priority: "high", ttl: 3600 * 1000 } };
  const data: FcmData = {};
  for (const [k, v] of Object.entries(m.data ?? {})) if (v !== undefined && v !== null) data[k] = typeof v === "string" ? v : JSON.stringify(v);
  return {
    token: m.to,
    data,
    notification: { title: m.title ?? "", body: m.body ?? "" },
    // Short life: a reminder that can't arrive within 10 minutes is not worth showing late.
    android: { priority: "high", ttl: 10 * 60000, notification: { channelId: m.notify.channelId, tag: m.notify.tag, icon: "notification_icon", color: "#0A6FD6" } },
  };
}
