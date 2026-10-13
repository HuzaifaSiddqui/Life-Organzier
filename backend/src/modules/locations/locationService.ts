import { TaskStatus, type SavedLocation, type Task, type UserSettings } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../config/db.js";
import { HttpError } from "../../lib/http.js";

/** FR-LB-001: saved places and their attachment to tasks. The phone does all geofence monitoring. */

export const PRESETS = { PRECISE: 200, NEARBY: 350, AREA: 750 } as const;
export type Preset = keyof typeof PRESETS;

export const locationInput = z.object({
  name: z.string().trim().min(1).max(100),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusM: z.number().int().min(100).max(2000).optional(),
  preset: z.enum(["PRECISE", "NEARBY", "AREA"]).optional(),
});
export type LocationInput = z.infer<typeof locationInput>;

/** Radius from an explicit value, else from the preset, else Nearby (350 m). */
export function resolveRadius(input: { radiusM?: number; preset?: Preset }): { radiusM: number; preset: Preset } {
  const preset = input.preset ?? "NEARBY";
  return { radiusM: input.radiusM ?? PRESETS[preset], preset };
}

export function requirePro(settings: UserSettings): void {
  if (settings.tier !== "PRO") throw new HttpError(403, "PRO_REQUIRED", "Location reminders are part of Pro");
}

export type TaskLocationOut = {
  id: string;
  savedLocationId: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusM: number;
  preset: string;
  usageCount: number;
  active: boolean;
  lastTriggeredAt: string | null;
};

const ACTIVE_STATUSES: TaskStatus[] = [TaskStatus.PENDING, TaskStatus.IN_PROGRESS];

/** Locations for many tasks in one query, keyed by task id. */
export async function locationsForTasks(tasks: Pick<Task, "id" | "status">[]): Promise<Map<string, TaskLocationOut[]>> {
  const out = new Map<string, TaskLocationOut[]>();
  if (!tasks.length) return out;
  const status = new Map(tasks.map((t) => [t.id, t.status]));
  const rows = await prisma.taskLocation.findMany({ where: { taskId: { in: tasks.map((t) => t.id) } }, include: { savedLocation: true }, orderBy: { createdAt: "asc" } });
  for (const r of rows) {
    const s = r.savedLocation;
    const list = out.get(r.taskId) ?? [];
    list.push({
      id: r.id,
      savedLocationId: s.id,
      name: s.name,
      latitude: s.latitude,
      longitude: s.longitude,
      radiusM: s.radiusM,
      preset: s.preset,
      usageCount: s.usageCount,
      // the task's own status wins, so paths that change status without the hook below still read correctly
      active: r.active && ACTIVE_STATUSES.includes(status.get(r.taskId) as TaskStatus),
      lastTriggeredAt: r.lastTriggeredAt?.toISOString() ?? null,
    });
    out.set(r.taskId, list);
  }
  return out;
}

/** Adds `locations` to serialized tasks. */
export async function withLocations<T extends { id: string; status: TaskStatus }>(tasks: T[]): Promise<Array<T & { locations: TaskLocationOut[] }>> {
  const map = await locationsForTasks(tasks);
  return tasks.map((t) => ({ ...t, locations: map.get(t.id) ?? [] }));
}

/** Completed/deleted tasks stop geofencing; reopened or restored tasks start again. */
export async function setTaskLocationsActive(taskId: string, status: TaskStatus): Promise<void> {
  await prisma.taskLocation.updateMany({ where: { taskId }, data: { active: ACTIVE_STATUSES.includes(status) } });
}

/** Tasks whose location data changed are re-sent by the next sync pull. */
async function touchTasks(where: { id?: string; locations?: { some: { savedLocationId: string } } }): Promise<void> {
  await prisma.task.updateMany({ where, data: { updatedAt: new Date() } });
}

export async function listLocations(userId: string): Promise<SavedLocation[]> {
  return prisma.savedLocation.findMany({ where: { userId }, orderBy: [{ usageCount: "desc" }, { name: "asc" }] });
}

/** Create, or return the existing place with the same name (case-insensitive). */
export async function createOrFindLocation(userId: string, input: LocationInput): Promise<{ location: SavedLocation; created: boolean }> {
  const existing = await prisma.savedLocation.findFirst({ where: { userId, name: { equals: input.name, mode: "insensitive" } } });
  if (existing) return { location: existing, created: false };
  const { radiusM, preset } = resolveRadius(input);
  try {
    const location = await prisma.savedLocation.create({ data: { userId, name: input.name, latitude: input.latitude, longitude: input.longitude, radiusM, preset } });
    return { location, created: true };
  } catch {
    // two creates at once: the other one won
    const again = await prisma.savedLocation.findFirst({ where: { userId, name: { equals: input.name, mode: "insensitive" } } });
    if (!again) throw new HttpError(409, "LOCATION_CONFLICT", "Couldn't save that place");
    return { location: again, created: false };
  }
}

async function ownLocation(userId: string, id: string): Promise<SavedLocation> {
  const loc = await prisma.savedLocation.findFirst({ where: { id, userId } });
  if (!loc) throw new HttpError(404, "LOCATION_NOT_FOUND", "Place not found");
  return loc;
}

export async function updateLocation(userId: string, id: string, patch: Partial<LocationInput>): Promise<SavedLocation> {
  const loc = await ownLocation(userId, id);
  if (patch.name && patch.name.toLowerCase() !== loc.name.toLowerCase()) {
    const clash = await prisma.savedLocation.findFirst({ where: { userId, id: { not: id }, name: { equals: patch.name, mode: "insensitive" } } });
    if (clash) throw new HttpError(409, "LOCATION_NAME_TAKEN", "You already have a place with that name");
  }
  // An explicit radius wins (keeping or setting the preset label); a preset alone sets its radius.
  const radius =
    patch.radiusM !== undefined
      ? { radiusM: patch.radiusM, preset: patch.preset ?? loc.preset }
      : patch.preset !== undefined
        ? { radiusM: PRESETS[patch.preset], preset: patch.preset }
        : {};
  const updated = await prisma.savedLocation.update({
    where: { id },
    data: {
      ...radius,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.latitude !== undefined ? { latitude: patch.latitude } : {}),
      ...(patch.longitude !== undefined ? { longitude: patch.longitude } : {}),
    },
  });
  await touchTasks({ locations: { some: { savedLocationId: id } } });
  return updated;
}

export async function deleteLocation(userId: string, id: string): Promise<void> {
  await ownLocation(userId, id);
  await touchTasks({ locations: { some: { savedLocationId: id } } });
  await prisma.savedLocation.delete({ where: { id } }); // TaskLocations cascade
}

export async function attachLocation(userId: string, taskId: string, savedLocationId: string): Promise<void> {
  const task = await prisma.task.findFirst({ where: { id: taskId, userId, status: { not: TaskStatus.DELETED } } });
  if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
  await ownLocation(userId, savedLocationId);
  const existing = await prisma.taskLocation.findUnique({ where: { taskId_savedLocationId: { taskId, savedLocationId } } });
  if (existing) return; // already attached: no double count
  await prisma.$transaction([
    prisma.taskLocation.create({ data: { taskId, savedLocationId, active: ACTIVE_STATUSES.includes(task.status) } }),
    prisma.savedLocation.update({ where: { id: savedLocationId }, data: { usageCount: { increment: 1 } } }),
  ]);
  await touchTasks({ id: taskId });
}

export async function detachLocation(userId: string, taskId: string, taskLocationId: string): Promise<void> {
  const r = await prisma.taskLocation.deleteMany({ where: { id: taskLocationId, taskId, task: { userId } } });
  if (!r.count) throw new HttpError(404, "TASK_LOCATION_NOT_FOUND", "That location isn't attached to this task");
  await touchTasks({ id: taskId });
}
