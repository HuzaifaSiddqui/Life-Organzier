import type { Task } from "../types/models";

/** FR-LB-001 geofence rules, kept free of native modules. */

export const MAX_REGIONS = 20; // iOS limit; also keeps Android cheap
export const DEDUP_MS = 4 * 3600000;

export type GeofenceTask = { taskId: string; taskLocationId: string; title: string; status: Task["status"]; scheduledStart: string | null };
export type GeofencePlace = { id: string; name: string; latitude: number; longitude: number; radiusM: number; usageCount: number; tasks: GeofenceTask[] };

const OPEN: Array<Task["status"]> = ["PENDING", "IN_PROGRESS"];

/**
 * One region per saved place with at least one open task; at most 20, most-used places first.
 * Returns the kept places and how many were dropped.
 */
export function placesFromTasks(tasks: Task[]): { places: GeofencePlace[]; dropped: number } {
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
  const all = [...byPlace.values()].sort((a, b) => b.usageCount - a.usageCount || a.name.localeCompare(b.name));
  return { places: all.slice(0, MAX_REGIONS), dropped: Math.max(0, all.length - MAX_REGIONS) };
}

/** Tasks to announce on entering: open, and not announced in the last 4 h (`lastAt` per taskLocationId). */
export function tasksToAnnounce(place: GeofencePlace, lastAt: Record<string, number | undefined>, now: number): GeofenceTask[] {
  return place.tasks.filter((t) => OPEN.includes(t.status) && !(now - (lastAt[t.taskLocationId] ?? -Infinity) < DEDUP_MS));
}

export type ArrivalMessage =
  | { kind: "single"; place: string; title: string }
  | { kind: "early"; place: string; title: string; at: string }
  | { kind: "few"; place: string; titles: string[] }
  | { kind: "many"; place: string; count: number };

/** Which wording to use; the caller turns it into localised text. */
export function arrivalMessage(placeName: string, tasks: GeofenceTask[], now: number): ArrivalMessage | null {
  if (!tasks.length) return null;
  if (tasks.length === 1) {
    const t = tasks[0];
    const start = t.scheduledStart ? Date.parse(t.scheduledStart) : NaN;
    return start > now ? { kind: "early", place: placeName, title: t.title, at: t.scheduledStart as string } : { kind: "single", place: placeName, title: t.title };
  }
  if (tasks.length <= 3) return { kind: "few", place: placeName, titles: tasks.map((t) => t.title) };
  return { kind: "many", place: placeName, count: tasks.length };
}

/** Great-circle distance in metres (for the foreground check and "1.2 km away"). */
export function distanceM(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
