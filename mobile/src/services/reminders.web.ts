import AsyncStorage from "@react-native-async-storage/async-storage";
import { auth } from "../lib/firebase";
import { desktopReminderItems, type DesktopPlan } from "../utils/desktopReminders";
import { apiGet, apiPost } from "./api";
import { showCheckinSheet, type PlannedCheckin } from "./checkins";
import { desktopBridge, type DesktopReminder } from "./desktopBridge";

/**
 * Web / desktop build of services/reminders.ts (Metro picks this file for web; same exports). The desktop shell
 * (Electron, desktop/) fires the notifications from the same server plan the phone uses (FR-RN-002 "Desktop: system
 * notification API"), honouring the device choice (FR-AP-002). A plain browser has no bridge: everything is a no-op.
 * Windows notifications have no action buttons, so a click opens the task / check-in in the app.
 */

export const CATEGORY_LOCATION = "lo-location";
export const DEFAULT_CHANNEL_ID = "lo-sound-vibrate";
const SNOOZES_KEY = "life-organizer:desktop-snoozes";

export type ReminderOpenTarget = { taskId: string | null; routineOccurrenceId: string | null; taskIds?: string[] };

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let lastPlanned: DesktopReminder[] = [];

export async function configureReminders(): Promise<void> {}

export async function ensureNotificationCategories(): Promise<void> {}

export async function ensureNotificationPermissions(): Promise<boolean> {
  return desktopBridge() !== null;
}

/** "Snooze" made on this computer: kept until it fires or the task is done, merged into every re-plan. */
async function readSnoozes(): Promise<DesktopReminder[]> {
  try {
    const list = JSON.parse((await AsyncStorage.getItem(SNOOZES_KEY)) ?? "[]") as DesktopReminder[];
    return Array.isArray(list) ? list.filter((s) => new Date(s.fireAt).getTime() > Date.now()) : [];
  } catch {
    return [];
  }
}

async function writeSnoozes(list: DesktopReminder[]): Promise<void> {
  await AsyncStorage.setItem(SNOOZES_KEY, JSON.stringify(list)).catch(() => undefined);
}

async function push(planned: DesktopReminder[]): Promise<number> {
  const bridge = desktopBridge();
  if (!bridge) return 0;
  lastPlanned = planned;
  const all = [...planned, ...(await readSnoozes())];
  await bridge.scheduleReminders(all);
  return all.length;
}

/**
 * The phone re-plans when a push says something changed; the desktop has no push, so it also re-plans on a timer
 * (changes made on the phone or WhatsApp reach desktop notifications within this interval, FR-MS-003).
 */
const REPLAN_MS = 10 * 60000;
let replanTimer: ReturnType<typeof setInterval> | null = null;

/** Downloads the reminder plan and hands it to the desktop shell. Keeps the old schedule when offline. */
export async function syncReminders(): Promise<number | null> {
  if (!auth.currentUser || !desktopBridge()) return null;
  replanTimer ??= setInterval(() => void syncReminders(), REPLAN_MS);
  let plan: DesktopPlan;
  try {
    plan = await apiGet<DesktopPlan>("/reminders/plan?days=7");
  } catch {
    return null;
  }
  return push(desktopReminderItems(plan, Date.now()));
}

export function scheduleReminderSync(delayMs = 1500): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncReminders();
  }, delayMs);
}

export async function scheduleCheckin(c: PlannedCheckin): Promise<boolean> {
  if (!desktopBridge() || new Date(c.fireAt).getTime() <= Date.now() + 5000) return false;
  const item: DesktopReminder = { id: `c:${c.id}`, fireAt: c.fireAt, title: c.title, body: c.body, taskId: c.taskId, routineOccurrenceId: null, kind: "checkin", checkinId: c.id, category: c.category };
  await push([...lastPlanned.filter((p) => p.id !== item.id), item]);
  return true;
}

/** Home's "Snooze 1 h": one reminder for the task in `minutes`; snoozing again replaces it. */
export async function snoozeTaskReminder(task: { id: string; title: string }, minutes: number): Promise<Date | null> {
  if (!desktopBridge()) return null;
  const fireAt = new Date(Date.now() + minutes * 60000);
  const item: DesktopReminder = { id: `snooze:t:${task.id}`, fireAt: fireAt.toISOString(), title: "Reminder", body: task.title, taskId: task.id, routineOccurrenceId: null, kind: "reminder" };
  await writeSnoozes([...(await readSnoozes()).filter((s) => s.taskId !== task.id), item]);
  await push(lastPlanned);
  return fireAt;
}

export async function cancelTaskSnooze(taskId: string): Promise<void> {
  await writeSnoozes((await readSnoozes()).filter((s) => s.taskId !== taskId));
  await push(lastPlanned);
}

export async function afterCheckinAnswer(taskId: string, next: PlannedCheckin | null | undefined): Promise<void> {
  lastPlanned = lastPlanned.filter((p) => !(p.kind === "checkin" && p.taskId === taskId));
  if (next) await scheduleCheckin(next);
  scheduleReminderSync();
}

/** A clicked notification opens what it is about (check-ins open their sheet, like a plain tap on the phone). */
export function startReminderResponses(onOpen: (target: ReminderOpenTarget) => void): () => void {
  const bridge = desktopBridge();
  if (!bridge) return () => undefined;
  return bridge.onReminderClick((item) => {
    if (item.kind === "checkin" && item.checkinId && item.taskId) {
      showCheckinSheet({ mode: item.category === "START" ? "start" : "update", checkinId: item.checkinId, taskId: item.taskId, title: item.title, body: item.body });
      return;
    }
    onOpen({ taskId: item.taskId, routineOccurrenceId: item.routineOccurrenceId });
    apiPost("/reminders/action", { taskId: item.taskId, fireAt: item.fireAt, action: "OPEN" }).catch(() => undefined);
  });
}

/** Clears every scheduled reminder (sign out). */
export async function clearAllReminders(): Promise<void> {
  if (replanTimer) clearInterval(replanTimer);
  replanTimer = null;
  lastPlanned = [];
  await writeSnoozes([]);
  await desktopBridge()?.clearReminders();
}
