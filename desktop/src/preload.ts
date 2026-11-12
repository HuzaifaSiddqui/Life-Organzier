import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { DesktopReminder } from "./bridge";

/**
 * Exposes `window.lifeOrganizer` (mobile/src/services/desktopBridge.ts) to the app. Sandboxed preloads can only load
 * `electron`, so the channel names are written out here; test/bridge.test.ts checks they match src/bridge.ts IPC.
 */
const CH = {
  schedule: "reminders:schedule",
  clear: "reminders:clear",
  click: "reminders:click",
  getLogin: "app:get-launch-at-login",
  setLogin: "app:set-launch-at-login",
};

contextBridge.exposeInMainWorld("lifeOrganizer", {
  platform: "desktop",
  scheduleReminders: (items: DesktopReminder[]) => ipcRenderer.invoke(CH.schedule, items),
  clearReminders: () => ipcRenderer.invoke(CH.clear),
  onReminderClick: (cb: (item: DesktopReminder) => void) => {
    const listener = (_e: IpcRendererEvent, item: DesktopReminder) => cb(item);
    ipcRenderer.on(CH.click, listener);
    return () => {
      ipcRenderer.removeListener(CH.click, listener);
    };
  },
  getLaunchAtLogin: () => ipcRenderer.invoke(CH.getLogin),
  setLaunchAtLogin: (on: boolean) => ipcRenderer.invoke(CH.setLogin, Boolean(on)),
});
