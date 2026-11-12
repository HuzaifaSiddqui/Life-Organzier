import type { Task } from "../types/models";

/**
 * Web / desktop build of services/locationReminders.ts. Location reminders (FR-LB-001) need the phone's background
 * geofencing, which a computer doesn't have, so they are off on desktop and the location UI is hidden. Same
 * exports; reads report "off", writes do nothing.
 */

export const GEOFENCE_TASK_NAME = "LIFE_ORGANIZER_GEOFENCE";
export const RADIUS_PRESETS = { PRECISE: 200, NEARBY: 350, AREA: 750 } as const;
export type RadiusPreset = keyof typeof RADIUS_PRESETS;
export type PermissionLevel = "background" | "foreground" | "denied";
export type LocationSnack = { text: string; action?: { label: string; onPress: () => void } };

const snackListeners = new Set<(s: LocationSnack | null) => void>();

export function showLocationSnackbar(s: LocationSnack | null): void {
  snackListeners.forEach((l) => l(s));
}

export function subscribeLocationSnackbar(listener: (s: LocationSnack | null) => void): () => void {
  snackListeners.add(listener);
  return () => snackListeners.delete(listener);
}

export async function getLocationPermission(): Promise<PermissionLevel> {
  return "denied";
}

export async function requestLocationPermission(): Promise<PermissionLevel> {
  return "denied";
}

export async function currentCoords(): Promise<{ latitude: number; longitude: number } | null> {
  return null;
}

export async function syncGeofences(_tasks?: Task[]): Promise<void> {}

export async function stopGeofencing(): Promise<void> {}

export async function clearGeofenceData(): Promise<void> {}

export async function cleanupGeofenceDedup(): Promise<void> {}

export async function takeLocationOnboarding(): Promise<boolean> {
  return false;
}

export async function isLocationRemindersEnabled(): Promise<boolean> {
  return false;
}

export async function locationRemindersReady(): Promise<boolean> {
  return false;
}

export async function setLocationRemindersEnabled(_on: boolean): Promise<PermissionLevel> {
  return "denied";
}

export function startLocationReminders(_opts: { isPro: boolean }): () => void {
  return () => undefined;
}
