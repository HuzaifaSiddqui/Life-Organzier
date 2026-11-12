import type { BusyEvent, Pulled, taskSpan } from "../utils/calendarSync";

/**
 * Web / desktop build of services/calendar.ts. CALENDAR_SYNC writes into the *phone's* calendar (expo-calendar), which
 * a computer doesn't have, so on desktop the feature reports itself off: the Settings card hides, chat's "am I free"
 * falls back to tasks only, and there are no clash cards. Same exports.
 */

export type EnableResult = "on" | "denied" | "unavailable";
export const CALENDAR_POLL_MS = 15 * 60000;
export const DAY_HOURS = { from: "08:00", to: "22:00" };

export async function calendarFeatureOn(_refresh = false): Promise<boolean> {
  return false;
}

export async function calendarSyncActive(): Promise<boolean> {
  return false;
}

export async function enableCalendarSync(): Promise<EnableResult> {
  return "unavailable";
}

export async function disableCalendarSync(): Promise<void> {}

export async function ourEventCount(): Promise<number> {
  return 0;
}

export async function removeAllCalendarEvents(): Promise<boolean> {
  return true;
}

export function subscribeCalendarChanges(_listener: (pulled: Pulled[]) => void): () => void {
  return () => undefined;
}

export function startCalendarWatch(): () => void {
  return () => undefined;
}

export function syncCalendar(): Promise<void> {
  return Promise.resolve();
}

export function scheduleCalendarSync(_delayMs = 2000): void {}

export async function readEvents(_from: number, _to: number, _opts: { others?: boolean } = {}): Promise<BusyEvent[] | null> {
  return null;
}

export async function clashesForTask(_task: Parameters<typeof taskSpan>[0]): Promise<BusyEvent[]> {
  return [];
}

export async function clashCardFor(
  _task: Parameters<typeof taskSpan>[0] & { id: string },
): Promise<{ type: "calendar_clash"; taskId: string; title: string; time: string; more: number } | null> {
  return null;
}

export async function agendaFor(_ymd: string): Promise<BusyEvent[] | null> {
  return null;
}

export async function freeTimeFor(_ymd: string, _now = Date.now()): Promise<Array<{ start: number; end: number }> | null> {
  return null;
}
