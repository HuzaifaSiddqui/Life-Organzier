import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { auth } from "../lib/firebase";
import { applyLastGoodApiBase } from "./apiResolver";
import { flushOutbox } from "./outbox";
import { handleBackgroundNotificationResponse, showPushNotification, syncReminders } from "./reminders";
import { syncNow } from "./syncEngine";

/**
 * Notification buttons answered without opening the app (Mark done, Snooze, Skip, Started…). On Android,
 * expo-notifications runs this task in a headless JS context when such a button is tapped while the app isn't in
 * front; when it is in front, the listener in services/reminders.ts handles it instead. Defined at module scope and
 * imported from index.ts, as expo-task-manager requires. Web / desktop: notificationActions.web.ts (nothing to do).
 */

export const NOTIFICATION_ACTION_TASK = "lo-notification-action";

/** The data of a push from the server (FCM data message): type, and loTitle / loBody when it should be shown. */
function pushData(payload: unknown): Record<string, string> | null {
  const p = payload as { data?: Record<string, unknown> & { dataString?: string } } | null;
  const raw = p?.data;
  if (!raw) return null;
  if (typeof raw.dataString === "string") {
    try {
      return JSON.parse(raw.dataString) as Record<string, string>;
    } catch {
      return null;
    }
  }
  const nested = raw.data as Record<string, string> | undefined;
  return (typeof raw.type === "string" ? raw : nested) as Record<string, string> | null;
}

TaskManager.defineTask<Notifications.NotificationTaskPayload>(NOTIFICATION_ACTION_TASK, async ({ data, error }) => {
  if (error || !data) return;
  // A button: clear the notification straight away, before the session and network work below (also if they fail).
  if ("actionIdentifier" in data) await Notifications.dismissNotificationAsync(data.notification.request.identifier).catch(() => undefined);
  try {
    // A headless start: wait for Firebase to restore the session and use the last server address that worked.
    await auth.authStateReady();
    if (!auth.currentUser) return;
    await applyLastGoodApiBase();
    if ("actionIdentifier" in data) {
      await handleBackgroundNotificationResponse(data);
      await flushOutbox();
      return;
    }
    // A push from the server: something changed elsewhere. Pull it and re-plan the alarms, app closed or not.
    const push = pushData(data);
    if (!push || (push.type !== "sync" && push.type !== "collab")) return;
    await syncNow();
    await syncReminders();
    if (push.loTitle) await showPushNotification(push.loTitle, push.loBody ?? "", push);
  } catch (e) {
    console.warn("Notification task failed", e instanceof Error ? e.message : e);
  }
});

/** Registers the task once per start (idempotent). */
export function registerNotificationActions(): void {
  void Notifications.registerTaskAsync(NOTIFICATION_ACTION_TASK).catch((e: unknown) => console.warn("Could not register notification actions", e));
}
