import type { StringKey } from "../i18n/strings";

/**
 * How a reminder notification looks on Android (services/reminders.ts): a short label next to the app name (the
 * notification's subtitle / subText) and the accent tint of the small icon and action buttons. Urgent and due-now
 * reminders are tinted with the danger colour so they stand out in the shade. Tested in __tests__/notificationLook.test.ts.
 */

export type NotificationKind = "task" | "routine" | "checkin" | "location";
export type NotificationLook = { label: StringKey; tone: "accent" | "danger" };

export function notificationLook(kind: NotificationKind, level?: string | null): NotificationLook {
  if (kind === "routine") return { label: "notif.routine", tone: "accent" };
  if (kind === "checkin") return { label: "notif.checkin", tone: "accent" };
  if (kind === "location") return { label: "notif.place", tone: "accent" };
  if (level === "critical") return { label: "notif.dueNow", tone: "danger" };
  if (level === "urgent") return { label: "notif.dueSoon", tone: "danger" };
  return { label: "notif.task", tone: "accent" };
}
