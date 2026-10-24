import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { AppState, Platform } from "react-native";
import { dictionaries, type Language, type StringKey } from "../i18n/strings";
import type { Task } from "../types/models";
import { buildNotificationBody, distanceM, groupTasksByLocation, locatedTaskIds, selectTopLocations, shouldAskForLocation, tasksToAnnounce, type GeofencePlace } from "../utils/geofence";
import { CATEGORY_LOCATION, DEFAULT_CHANNEL_ID, ensureNotificationCategories } from "./reminders";
import { auth } from "../lib/firebase";
import { readTasks, subscribeTasks } from "./syncEngine";

/**
 * FR-LB-001 location reminders. The phone does all geofence monitoring; the server only stores places.
 *
 * Event-driven only: with "Allow all the time" the OS reports entering/leaving each place (even with
 * the app closed). With "While using the app" Android won't geofence, so the last known position is
 * checked once each time the app comes to the foreground. No continuous tracking.
 *
 * The background task can run headless before Firebase restores the user, so it reads a snapshot of
 * places and their tasks from a fixed storage key (written here whenever the task cache changes), not
 * the per-user task cache.
 */

export const GEOFENCE_TASK_NAME = "LIFE_ORGANIZER_GEOFENCE";
const DEDUP_PREFIX = "geofence_triggered_";
const SNAPSHOT_KEY = "life-organizer:geofence-places";
const BG_HINT_KEY = "location_background_hint_shown";
/** Per user and device: the first-time Home / University sheet was shown. */
const onboardingKey = () => `location_onboarding_shown:${auth.currentUser?.uid ?? "guest"}`;
/** Per user and device: the Settings toggle (default off). */
const enabledKey = () => `location_reminders_enabled:${auth.currentUser?.uid ?? "guest"}`;

/** Keep in sync with backend PRESETS (locations/locationService.ts). */
export const RADIUS_PRESETS = { PRECISE: 200, NEARBY: 350, AREA: 750 } as const;
export type RadiusPreset = keyof typeof RADIUS_PRESETS;
export type PermissionLevel = "background" | "foreground" | "denied";

/* ------------------------------------------------------------------ storage (never throws) */

async function getItem(key: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(key);
  } catch {
    return null;
  }
}

async function setItem(key: string, value: string): Promise<void> {
  try {
    await AsyncStorage.setItem(key, value);
  } catch {
    // storage unavailable: worst case a reminder repeats
  }
}

async function removeKeys(keys: string[]): Promise<void> {
  if (!keys.length) return;
  try {
    await AsyncStorage.multiRemove(keys);
  } catch {
    // ignore
  }
}

async function dedupKeys(): Promise<string[]> {
  try {
    return (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(DEDUP_PREFIX));
  } catch {
    return [];
  }
}

async function readSnapshot(): Promise<GeofencePlace[]> {
  try {
    const list = JSON.parse((await getItem(SNAPSHOT_KEY)) ?? "[]") as GeofencePlace[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ permission */

export type LocationSnack = { text: string; action?: { label: string; onPress: () => void } };
const snackListeners = new Set<(s: LocationSnack | null) => void>();

/** App-level location messages (permission hint, "Location removed · Undo"), rendered by LocationSnackbar. */
export function showLocationSnackbar(s: LocationSnack | null): void {
  snackListeners.forEach((l) => l(s));
}

export function subscribeLocationSnackbar(listener: (s: LocationSnack | null) => void): () => void {
  snackListeners.add(listener);
  return () => snackListeners.delete(listener);
}

async function uiLanguage(): Promise<Language> {
  return (await getItem("ui.language")) === "ur" ? "ur" : "en";
}

async function tr(key: StringKey, vars: Record<string, string | number> = {}): Promise<string> {
  const lang = await uiLanguage();
  const text = dictionaries[lang][key] ?? dictionaries.en[key];
  return text.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
}

/** Current level without prompting. */
export async function getLocationPermission(): Promise<PermissionLevel> {
  try {
    if (!(await Location.getForegroundPermissionsAsync()).granted) return "denied";
    return (await Location.getBackgroundPermissionsAsync()).granted ? "background" : "foreground";
  } catch {
    return "denied";
  }
}

/** Foreground first, then background. A background refusal shows a one-time hint but never blocks. */
export async function requestLocationPermission(): Promise<PermissionLevel> {
  try {
    if (!(await Location.requestForegroundPermissionsAsync()).granted) return "denied";
    if ((await Location.requestBackgroundPermissionsAsync()).granted) return "background";
  } catch (error) {
    console.warn("Location permission request failed", error);
    return getLocationPermission();
  }
  if (!(await getItem(BG_HINT_KEY))) {
    await setItem(BG_HINT_KEY, "1");
    const text = await tr("location.backgroundHint");
    showLocationSnackbar({ text });
  }
  return "foreground";
}

/**
 * Where the phone is now, for "Use current location": a fix from the last 2 minutes is instant; otherwise
 * a fresh one, given up after 15 s indoors. Null when not allowed or no fix.
 */
export async function currentCoords(): Promise<{ latitude: number; longitude: number } | null> {
  try {
    const recent = await Location.getLastKnownPositionAsync({ maxAge: 120000, requiredAccuracy: 200 });
    if (recent) return recent.coords;
    const fresh = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 15000)),
    ]);
    return fresh?.coords ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ geofences */

let enabled = false;

/** (Re)builds regions from the task cache. Stops monitoring when off, not Pro, or nothing to watch. */
export async function syncGeofences(tasks?: Task[]): Promise<void> {
  const { places, dropped } = selectTopLocations(groupTasksByLocation(tasks ?? (await readTasks())));
  if (dropped) console.warn(`Location reminders: watching the ${places.length} most-used places, ${dropped} more skipped (limit)`);
  await setItem(SNAPSHOT_KEY, JSON.stringify(places));
  const level = enabled ? await getLocationPermission() : "denied";
  if (level !== "background" || !places.length) {
    await stopMonitoring();
    return;
  }
  try {
    await Location.startGeofencingAsync(
      GEOFENCE_TASK_NAME,
      places.map((p) => ({ identifier: p.id, latitude: p.latitude, longitude: p.longitude, radius: p.radiusM, notifyOnEnter: true, notifyOnExit: true })),
    );
  } catch (error) {
    console.warn("Could not start geofencing", error);
  }
}

async function stopMonitoring(): Promise<void> {
  try {
    if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK_NAME)) await Location.stopGeofencingAsync(GEOFENCE_TASK_NAME);
  } catch {
    // not started
  }
}

/** Stops monitoring (location reminders turned off, or not Pro). Saved places are untouched. */
export async function stopGeofencing(): Promise<void> {
  enabled = false;
  await stopMonitoring();
}

/** Sign out: stop, and forget the snapshot and once-per-visit marks on this phone. */
export async function clearGeofenceData(): Promise<void> {
  await stopGeofencing();
  await removeKeys([SNAPSHOT_KEY, ...(await dedupKeys())]);
}

/** Once per app start: drop once-per-visit marks older than a day. */
export async function cleanupGeofenceDedup(): Promise<void> {
  const keys = await dedupKeys();
  const now = Date.now();
  const stale: string[] = [];
  for (const key of keys) {
    const ts = Number(await getItem(key));
    if (!ts || now - ts > 24 * 3600000) stale.push(key);
  }
  await removeKeys(stale);
}

/* ------------------------------------------------------------------ arrival / departure */

async function handleGeofenceEnter(savedLocationId: string): Promise<void> {
  // Location notifications bypass quiet hours — user needs the reminder when they arrive.
  // (Check-ins and timed reminders respect quiet hours; that is decided on the server.)
  const place = (await readSnapshot()).find((p) => p.id === savedLocationId);
  if (!place) return;
  const now = Date.now();
  const lastAt: Record<string, number> = {};
  for (const t of place.tasks) lastAt[t.taskLocationId] = Number(await getItem(DEDUP_PREFIX + t.taskLocationId)) || 0;
  const due = tasksToAnnounce(place, lastAt, now);
  const lang = await uiLanguage();
  const locale = lang === "ur" ? "ur-PK" : undefined;
  const formatTime = (iso: string) => {
    const d = new Date(iso);
    const sameDay = d.toDateString() === new Date(now).toDateString();
    return d.toLocaleString(locale, sameDay ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
  };
  const body = buildNotificationBody(place.name, due, now, lang, formatTime);
  if (!body) return;
  for (const t of due) await setItem(DEDUP_PREFIX + t.taskLocationId, String(now));

  try {
    await ensureNotificationCategories(); // headless launch: categories may not be registered yet
    await Notifications.scheduleNotificationAsync({
      identifier: `lo-loc:${savedLocationId}:${now}`,
      content: {
        title: await tr("location.notifTitle"),
        body,
        categoryIdentifier: CATEGORY_LOCATION,
        data: { kind: "lo-location", savedLocationId, taskIds: due.map((t) => t.taskId) },
        ...(Platform.OS === "android" ? { priority: Notifications.AndroidNotificationPriority.HIGH } : {}),
      },
      trigger: Platform.OS === "android" ? { channelId: DEFAULT_CHANNEL_ID } : null,
    });
  } catch (error) {
    console.warn("Could not show location reminder", error);
  }
}

/** Leaving clears the marks, so coming back later reminds again. No notification. */
async function handleGeofenceExit(savedLocationId: string): Promise<void> {
  const place = (await readSnapshot()).find((p) => p.id === savedLocationId);
  if (place) await removeKeys(place.tasks.map((t) => DEDUP_PREFIX + t.taskLocationId));
}

TaskManager.defineTask(GEOFENCE_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.error("[Geofence] Task error:", error);
    return;
  }
  const { eventType, region } = data as { eventType: Location.GeofencingEventType; region: Location.LocationRegion };
  if (!region?.identifier) return;
  if (eventType === Location.GeofencingEventType.Enter) await handleGeofenceEnter(region.identifier);
  else if (eventType === Location.GeofencingEventType.Exit) await handleGeofenceExit(region.identifier);
});

/** "While using the app" only: one position check when the app opens. */
async function foregroundCheck(): Promise<void> {
  if (!enabled || (await getLocationPermission()) !== "foreground") return;
  try {
    const pos = await Location.getLastKnownPositionAsync({ maxAge: 10 * 60000 });
    if (!pos) return;
    for (const p of await readSnapshot()) {
      if (distanceM(pos.coords, p) <= p.radiusM) await handleGeofenceEnter(p.id);
    }
  } catch (error) {
    console.warn("Location check failed", error);
  }
}

/* ------------------------------------------------------------------ lifecycle */

/** True once: the first time location reminders are turned on (and allowed) on this phone. */
export async function takeLocationOnboarding(): Promise<boolean> {
  if (await getItem(onboardingKey())) return false;
  await setItem(onboardingKey(), "1");
  return true;
}

export async function isLocationRemindersEnabled(): Promise<boolean> {
  return (await getItem(enabledKey())) === "1";
}

/**
 * The Settings toggle. On: asks for permission; refused → stays off (returns "denied"). Off: stops
 * monitoring. Only Pro users can turn it on (the Settings screen disables it otherwise).
 */
export async function setLocationRemindersEnabled(on: boolean): Promise<PermissionLevel> {
  if (!on) {
    await setItem(enabledKey(), "0");
    await stopGeofencing();
    return getLocationPermission();
  }
  const level = await requestLocationPermission();
  if (level === "denied") return level;
  await setItem(enabledKey(), "1");
  enabled = true;
  await syncGeofences();
  await foregroundCheck();
  return level;
}

/**
 * Called when the signed-in user's settings are known. Geofences follow the task cache (sync pulls,
 * creates, edits and deletes all write it) while the user is Pro and has the toggle on. Never opens the
 * permission dialog itself: a task with a place while reminders can't fire shows a "Grant" snackbar.
 */
export function startLocationReminders(opts: { isPro: boolean }): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let seen: Set<string> | null = null;
  // A task with a place (from chat, the form, WhatsApp or sync) while reminders can't fire: offer "Grant".
  // A snackbar, not the system dialog, so the user chooses; the dialog opens from its button.
  const askIfNeeded = async () => {
    if (!opts.isPro) return;
    const located = locatedTaskIds(await readTasks());
    const ready = enabled && (await getLocationPermission()) !== "denied";
    const ask = shouldAskForLocation(seen, located, ready);
    seen = new Set(located);
    if (!ask) return;
    const label = await tr("location.grant");
    showLocationSnackbar({ text: await tr("location.grantHint"), action: { label, onPress: () => void setLocationRemindersEnabled(true) } });
  };
  const resync = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void syncGeofences().then(askIfNeeded), 1000);
  };
  void (async () => {
    await cleanupGeofenceDedup();
    enabled = opts.isPro && (await isLocationRemindersEnabled());
    await syncGeofences(); // stops monitoring when not enabled
    await foregroundCheck();
    await askIfNeeded();
  })();
  const stopTasks = subscribeTasks(resync);
  const app = AppState.addEventListener("change", (s) => {
    if (s === "active") void syncGeofences().then(foregroundCheck); // permission may have changed in Settings
  });
  return () => {
    if (timer) clearTimeout(timer);
    stopTasks();
    app.remove();
  };
}
