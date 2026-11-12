/**
 * Desktop app (Electron, desktop/): the preload script exposes `window.lifeOrganizer`. In a plain browser or on the
 * phone it is absent, so every caller treats `null` as "not on desktop". The shape is mirrored in
 * desktop/src/bridge.ts — keep the two in step.
 */

/** One OS notification the desktop shell fires at `fireAt` (ISO), even while the window is hidden in the tray. */
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

export type DesktopBridge = {
  platform: "desktop";
  /** Replaces every scheduled reminder with this list. */
  scheduleReminders(items: DesktopReminder[]): Promise<void>;
  clearReminders(): Promise<void>;
  /** A notification was clicked: the window is focused and this runs with the reminder. */
  onReminderClick(cb: (item: DesktopReminder) => void): () => void;
  getLaunchAtLogin(): Promise<boolean>;
  setLaunchAtLogin(on: boolean): Promise<void>;
};

export function desktopBridge(): DesktopBridge | null {
  const g = globalThis as { lifeOrganizer?: DesktopBridge };
  return g.lifeOrganizer?.platform === "desktop" ? g.lifeOrganizer : null;
}

export const isDesktopApp = (): boolean => desktopBridge() !== null;
