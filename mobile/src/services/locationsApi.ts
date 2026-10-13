import type { SavedLocation, Task, TaskLocation } from "../types/models";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";
import { readTasks, writeTasks } from "./syncEngine";

/** FR-LB-001 places and geocoding. All geocoding goes through the backend (Nominatim there). */

export type GeoResult = { name: string; displayName: string; latitude: number; longitude: number };
export type PlaceInput = { name: string; latitude: number; longitude: number; preset?: SavedLocation["preset"]; displayAddress?: string | null };

export async function listPlaces(): Promise<SavedLocation[]> {
  return (await apiGet<{ locations: SavedLocation[] }>("/locations")).locations;
}

/** Returns the existing place when the name is already saved (any case). */
export async function savePlace(input: PlaceInput): Promise<SavedLocation> {
  return (await apiPost<{ location: SavedLocation }>("/locations", input)).location;
}

export async function updatePlace(id: string, patch: Partial<PlaceInput>): Promise<SavedLocation> {
  return (await apiPut<{ location: SavedLocation }>(`/locations/${id}`, patch)).location;
}

export async function deletePlace(id: string): Promise<void> {
  await apiDelete(`/locations/${id}`);
  // links to it are gone on the server; drop them locally so geofences update now, not at next sync
  const tasks = await readTasks();
  await writeTasks(tasks.map((t) => (t.locations?.some((l) => l.savedLocationId === id) ? { ...t, locations: t.locations.filter((l) => l.savedLocationId !== id) } : t)));
}

/** Writes the server's location list into the cached task, so geofences follow at once. */
async function cacheLocations(task: Task | null): Promise<TaskLocation[]> {
  if (!task) return [];
  const tasks = await readTasks();
  await writeTasks(tasks.map((t) => (t.id === task.id ? { ...t, locations: task.locations ?? [] } : t)));
  return task.locations ?? [];
}

export async function attachPlace(taskId: string, savedLocationId: string): Promise<TaskLocation[]> {
  return cacheLocations((await apiPost<{ task: Task | null }>(`/tasks/${taskId}/locations`, { savedLocationId })).task);
}

export async function detachPlace(taskId: string, taskLocationId: string): Promise<TaskLocation[]> {
  return cacheLocations((await apiDelete<{ task: Task | null }>(`/tasks/${taskId}/locations/${taskLocationId}`)).task);
}

export async function searchPlaces(q: string, near: { latitude: number; longitude: number } | null): Promise<GeoResult[]> {
  const params: Record<string, string | number> = { q };
  if (near) Object.assign(params, { near_lat: near.latitude, near_lng: near.longitude });
  return (await apiGet<{ results: GeoResult[] }>("/geocode", { params })).results;
}

export async function placeAt(latitude: number, longitude: number): Promise<GeoResult | null> {
  return (await apiGet<{ result: GeoResult | null }>("/geocode/reverse", { params: { lat: latitude, lng: longitude } })).result;
}
