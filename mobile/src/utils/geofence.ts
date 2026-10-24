import { dictionaries, type Language } from "../i18n/strings";
import type { Task } from "../types/models";

/** FR-LB-001 geofence rules, kept free of native modules (unit-tested in __tests__/geofence.test.ts). */

export const MAX_REGIONS = 20; // iOS limit; also keeps Android cheap
export const DEDUP_MS = 4 * 3600000;

export type GeofenceTask = { taskId: string; taskLocationId: string; title: string; status: Task["status"]; scheduledStart: string | null };
export type GeofencePlace = { id: string; name: string; latitude: number; longitude: number; radiusM: number; usageCount: number; tasks: GeofenceTask[] };

const OPEN: Array<Task["status"]> = ["PENDING", "IN_PROGRESS"];

/** One entry per saved place that has at least one open task with an active link. */
export function groupTasksByLocation(tasks: Task[]): GeofencePlace[] {
  const byPlace = new Map<string, GeofencePlace>();
  for (const t of tasks) {
    if (!OPEN.includes(t.status)) continue;
    for (const l of t.locations ?? []) {
      if (!l.active) continue;
      const p = byPlace.get(l.savedLocationId) ?? { id: l.savedLocationId, name: l.name, latitude: l.latitude, longitude: l.longitude, radiusM: l.radiusM, usageCount: l.usageCount, tasks: [] };
      p.tasks.push({ taskId: t.id, taskLocationId: l.id, title: t.title, status: t.status, scheduledStart: t.scheduledStart ?? null });
      byPlace.set(l.savedLocationId, p);
    }
  }
  return [...byPlace.values()];
}

/** Open tasks with an active place: the ones location reminders watch. */
export function locatedTaskIds(tasks: Task[]): string[] {
  return [...new Set(groupTasksByLocation(tasks).flatMap((p) => p.tasks.map((t) => t.taskId)))];
}

/**
 * A place just added to a task while the user is already there: Android's "already inside" trigger can lag
 * by minutes, so these places are announced at once. Only places holding a newly located task, within radius.
 */
export function placesToAnnounceNow(places: GeofencePlace[], newTaskIds: string[], here: { latitude: number; longitude: number } | null): string[] {
  if (!here || !newTaskIds.length) return [];
  const fresh = new Set(newTaskIds);
  return places.filter((p) => p.tasks.some((t) => fresh.has(t.taskId)) && distanceM(here, p) <= p.radiusM).map((p) => p.id);
}

/** Chat and voice tasks get the in-chat Location card instead of the snackbar (one prompt per task). */
export function promptedInChat(task: Pick<Task, "source">): boolean {
  return task.source === "CHAT" || task.source === "VOICE";
}

/**
 * Ask for location access when reminders can't fire (toggle off or permission denied) and a watched task is
 * new since the last check, or this is the first check since the app started. Asking once per new task never nags.
 */
export function shouldAskForLocation(seen: ReadonlySet<string> | null, located: string[], ready: boolean): boolean {
  if (ready || !located.length) return false;
  return !seen || located.some((id) => !seen.has(id));
}

/** The most-used places first, at most `max`; reports how many were left out. */
export function selectTopLocations(places: GeofencePlace[], max = MAX_REGIONS): { places: GeofencePlace[]; dropped: number } {
  const sorted = [...places].sort((a, b) => b.usageCount - a.usageCount || a.name.localeCompare(b.name));
  return { places: sorted.slice(0, max), dropped: Math.max(0, sorted.length - max) };
}

/** True while a task was announced less than 4 h ago (`lastAt` = epoch ms, or missing). */
export function isDedupActive(lastAt: number | null | undefined, now: number): boolean {
  return typeof lastAt === "number" && lastAt > 0 && now - lastAt < DEDUP_MS;
}

/** Tasks to announce on entering: open, and not announced in the last 4 h (`lastAt` per taskLocationId). */
export function tasksToAnnounce(place: GeofencePlace, lastAt: Record<string, number | undefined>, now: number): GeofenceTask[] {
  return place.tasks.filter((t) => OPEN.includes(t.status) && !isDedupActive(lastAt[t.taskLocationId], now));
}

const fill = (text: string, vars: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

/**
 * Arrival text. One task: "nearby", or "early" when its planned start is still ahead; 2–3 tasks: listed;
 * 4+: a count. `formatTime` turns the planned start into local clock text. Null when nothing to announce.
 */
export function buildNotificationBody(placeName: string, tasks: GeofenceTask[], now: number, lang: Language, formatTime: (iso: string) => string): string | null {
  const d = dictionaries[lang];
  if (!tasks.length) return null;
  if (tasks.length === 1) {
    const t = tasks[0];
    const start = t.scheduledStart ? Date.parse(t.scheduledStart) : NaN;
    return start > now
      ? fill(d["location.early"], { place: placeName, title: t.title, time: formatTime(t.scheduledStart as string) })
      : fill(d["location.single"], { place: placeName, title: t.title });
  }
  if (tasks.length <= 3) return fill(d["location.few"], { place: placeName, titles: tasks.map((t) => t.title).join(lang === "ur" ? "، " : ", ") });
  return fill(d["location.many"], { place: placeName, count: tasks.length });
}

/** Great-circle distance in metres (foreground check and "1.2 km away"). */
export function distanceM(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/** "350 m" / "1.2 km". */
export function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}
