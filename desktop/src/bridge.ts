/**
 * What the preload script exposes to the app as `window.lifeOrganizer`. Mirrors mobile/src/services/desktopBridge.ts
 * (the app side) — keep the two in step.
 */

export type DesktopReminder = {
  id: string;
  fireAt: string;
  title: string;
  body: string;
  taskId: string | null;
  routineOccurrenceId: string | null;
  kind: "reminder" | "checkin";
  checkinId?: string;
  category?: string;
};

export const IPC = {
  schedule: "reminders:schedule",
  clear: "reminders:clear",
  click: "reminders:click",
  getLogin: "app:get-launch-at-login",
  setLogin: "app:set-launch-at-login",
} as const;
