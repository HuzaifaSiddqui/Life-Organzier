/**
 * Web / desktop build of services/notificationActions.ts (same exports). Desktop notifications come from the Electron
 * shell (no action buttons, a click opens the app), so there is no background task to register.
 */

export const NOTIFICATION_ACTION_TASK = "lo-notification-action";

export function registerNotificationActions(): void {}
