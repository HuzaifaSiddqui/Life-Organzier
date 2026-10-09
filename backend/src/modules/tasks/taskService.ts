import {
  Prisma,
  ReminderMode,
  TaskSource,
  TaskStatus,
  TaskType,
  type Priority,
  type Task,
} from "@prisma/client";
import { prisma } from "../../config/db.js";
import { computeDueAt, localParts } from "../../lib/time.js";
import { cancelCheckins } from "../checkins/checkinLog.js";
import { refreshCheckinCopy } from "../checkins/copy.js";
import { logEvent } from "../events/eventService.js";

export type TaskContext = { userId: string; tz: string; deviceId?: string | null };

/** Fields that are user-editable, versioned and mergeable during sync. */
export const TASK_FIELDS = [
  "title",
  "description",
  "dueDate",
  "dueTime",
  "priority",
  "category",
  "status",
  "progress",
  "parentTaskId",
  "durationMinutes",
  "difficulty",
  "taskType",
  "archived",
  "tags",
  "locationContext",
  "reminderMinutes",
  "reminderMode",
  "scheduledStart",
  "scheduledEnd",
] as const;

export type TaskField = (typeof TASK_FIELDS)[number];

export type TaskChanges = Partial<{
  title: string;
  description: string | null;
  dueDate: Date | null;
  dueTime: string | null;
  priority: Priority;
  category: string | null;
  status: TaskStatus;
  progress: number;
  parentTaskId: string | null;
  durationMinutes: number | null;
  difficulty: number | null;
  taskType: TaskType;
  archived: boolean;
  tags: string[] | null;
  locationContext: string | null;
  reminderMinutes: number | null;
  reminderMode: ReminderMode;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
}>;

export type CreateTaskInput = TaskChanges & {
  title: string;
  priority: Priority;
  source: TaskSource;
  confidence?: number | null;
  clientId?: string | null;
  documentId?: string | null;
};

export type SerializedTask = Task & { isOverdue: boolean; subtaskCount?: number };

const ACTIVE: TaskStatus[] = [TaskStatus.PENDING, TaskStatus.IN_PROGRESS];

export function isTaskOverdue(task: Pick<Task, "dueAt" | "status" | "archived">, now = new Date()): boolean {
  return Boolean(task.dueAt && task.dueAt < now && ACTIVE.includes(task.status) && !task.archived);
}

export function serializeTask(task: Task, now = new Date()): SerializedTask {
  return { ...task, isOverdue: isTaskOverdue(task, now) };
}

export function snapshotOf(task: Task): Record<string, unknown> {
  const snap: Record<string, unknown> = {};
  for (const field of TASK_FIELDS) {
    const value = task[field];
    snap[field] = value instanceof Date ? value.toISOString() : (value ?? null);
  }
  return snap;
}

export function changesFromSnapshot(snapshot: Record<string, unknown>): TaskChanges {
  const out: Record<string, unknown> = {};
  for (const field of TASK_FIELDS) {
    if (!(field in snapshot)) continue;
    const value = snapshot[field];
    if (["dueDate", "scheduledStart", "scheduledEnd"].includes(field)) {
      out[field] = typeof value === "string" ? new Date(value) : null;
    } else {
      out[field] = value;
    }
  }
  return out as TaskChanges;
}

function jsonTags(tags: string[] | null | undefined): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (tags === undefined) return undefined;
  if (tags === null) return Prisma.JsonNull;
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
}

export async function listTasksForUser(
  userId: string,
  opts: { includeArchived?: boolean; since?: Date } = {},
): Promise<Task[]> {
  return prisma.task.findMany({
    where: {
      userId,
      ...(opts.since ? { updatedAt: { gt: opts.since } } : { status: { not: TaskStatus.DELETED } }),
      ...(opts.includeArchived || opts.since ? {} : { archived: false }),
    },
    orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
  });
}

export async function listActiveTasks(userId: string): Promise<Task[]> {
  return prisma.task.findMany({
    where: { userId, status: { in: ACTIVE }, archived: false },
    orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
  });
}

export async function getTaskForUser(userId: string, taskId: string): Promise<Task | null> {
  return prisma.task.findFirst({ where: { id: taskId, userId, status: { not: TaskStatus.DELETED } } });
}

async function recordVersion(task: Task, deviceId: string | null | undefined): Promise<void> {
  await prisma.taskVersion.upsert({
    where: { taskId_version: { taskId: task.id, version: task.version } },
    create: {
      taskId: task.id,
      userId: task.userId,
      version: task.version,
      snapshot: snapshotOf(task) as Prisma.InputJsonValue,
      deviceId: deviceId ?? null,
    },
    update: {},
  });
}

function completionPayload(task: Task, tz: string) {
  const at = task.completedAt ?? new Date();
  const local = localParts(at, tz);
  return {
    category: task.category,
    hour: local.h,
    weekday: local.weekday,
    onTime: task.dueAt ? at <= task.dueAt : null,
    leadHours: task.dueAt ? Math.round((task.dueAt.getTime() - at.getTime()) / 3600000) : null,
    durationMinutes: task.durationMinutes,
    difficulty: task.difficulty,
    priority: task.priority,
  };
}

export async function createTask(ctx: TaskContext, input: CreateTaskInput): Promise<Task> {
  if (input.clientId) {
    const existing = await prisma.task.findUnique({ where: { userId_clientId: { userId: ctx.userId, clientId: input.clientId } } });
    if (existing) return existing;
  }
  if (input.parentTaskId) {
    const parent = await prisma.task.findFirst({ where: { id: input.parentTaskId, userId: ctx.userId } });
    if (!parent) input.parentTaskId = null;
  }
  const status = input.status ?? TaskStatus.PENDING;
  const progress = status === TaskStatus.COMPLETED ? 100 : Math.max(0, Math.min(100, input.progress ?? 0));
  let task: Task;
  try {
    task = await prisma.task.create({
      data: {
        userId: ctx.userId,
        title: input.title.trim().slice(0, 300),
        description: input.description ?? null,
        dueDate: input.dueDate ?? null,
        dueTime: input.dueTime ?? null,
        dueAt: computeDueAt(input.dueDate ?? null, input.dueTime ?? null, ctx.tz),
        priority: input.priority,
        category: input.category ?? null,
        status,
        source: input.source,
        confidence: input.confidence ?? null,
        parentTaskId: input.parentTaskId ?? null,
        progress,
        durationMinutes: input.durationMinutes ?? null,
        difficulty: input.difficulty ?? null,
        taskType: input.taskType ?? TaskType.FLEXIBLE,
        archived: input.archived ?? false,
        tags: jsonTags(input.tags),
        locationContext: input.locationContext ?? null,
        reminderMinutes: input.reminderMinutes ?? null,
        reminderMode: input.reminderMode ?? ReminderMode.ADAPTIVE,
        scheduledStart: input.scheduledStart ?? null,
        scheduledEnd: input.scheduledEnd ?? null,
        completedAt: status === TaskStatus.COMPLETED ? new Date() : null,
        startedAt: status === TaskStatus.IN_PROGRESS ? new Date() : null,
        deviceId: ctx.deviceId ?? null,
        clientId: input.clientId ?? null,
        documentId: input.documentId ?? null,
      },
    });
  } catch (error) {
    // Two syncs racing with the same offline task: the loser returns the winner's task instead of failing.
    if (input.clientId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.task.findUnique({ where: { userId_clientId: { userId: ctx.userId, clientId: input.clientId } } });
      if (existing) return existing;
    }
    throw error;
  }
  await recordVersion(task, ctx.deviceId);
  if (task.scheduledStart) refreshCheckinCopy(task); // FR-RN-004: pre-write check-in messages
  logEvent(ctx.userId, "TASK_CREATED", task.id, { source: task.source, category: task.category, taskType: task.taskType });
  if (task.parentTaskId) await updateParentProgress(task.parentTaskId);
  return task;
}

/**
 * Applies changes with version tracking (FR-TM-004 / FR-MS-004). Keeps status/progress/completion
 * consistent, reschedules children when a parent's date moves (FR-TM-007) and rolls progress up.
 */
export async function updateTask(
  ctx: TaskContext,
  taskId: string,
  changes: TaskChanges,
  /** startedAt / completedAt: when it really happened (e.g. a check-in tap delivered late); default now. */
  opts: { clientModifiedAt?: Date; skipChildren?: boolean; startedAt?: Date; completedAt?: Date; completedVia?: "CHECKIN" | "MANUAL" } = {},
): Promise<Task | null> {
  const existing = await prisma.task.findFirst({ where: { id: taskId, userId: ctx.userId, status: { not: TaskStatus.DELETED } } });
  if (!existing) return null;
  const data: Prisma.TaskUncheckedUpdateInput = {};
  const c = { ...changes };

  if (c.parentTaskId) {
    if (c.parentTaskId === taskId) delete c.parentTaskId;
    else {
      const parent = await prisma.task.findFirst({ where: { id: c.parentTaskId, userId: ctx.userId } });
      if (!parent) delete c.parentTaskId;
    }
  }
  if (c.progress !== undefined) {
    c.progress = Math.max(0, Math.min(100, Math.round(c.progress)));
    if (c.progress === 100 && c.status === undefined) c.status = TaskStatus.COMPLETED;
    if (c.progress > 0 && c.progress < 100 && c.status === undefined && existing.status === TaskStatus.PENDING) {
      c.status = TaskStatus.IN_PROGRESS;
    }
  }
  if (c.status === TaskStatus.COMPLETED) {
    c.progress = 100;
    if (existing.status !== TaskStatus.COMPLETED) {
      data.completedAt = opts.completedAt ?? new Date();
      data.completedVia = opts.completedVia ?? "MANUAL";
    }
  } else if (c.status && existing.status === TaskStatus.COMPLETED) {
    data.completedAt = null;
    data.completedVia = null;
    if (c.progress === undefined) c.progress = Math.min(existing.progress, 75);
  }

  let changed = false;
  for (const field of TASK_FIELDS) {
    if (!(field in c)) continue;
    const next = (c as Record<string, unknown>)[field];
    if (next === undefined) continue;
    const prev = existing[field];
    const same =
      prev instanceof Date || next instanceof Date
        ? (prev as Date | null)?.getTime?.() === (next as Date | null)?.getTime?.()
        : JSON.stringify(prev ?? null) === JSON.stringify(next ?? null);
    if (same) continue;
    changed = true;
    if (field === "tags") data.tags = jsonTags(next as string[] | null);
    else (data as Record<string, unknown>)[field] = next;
  }
  if (!changed) return existing;
  // FR-RN-004: the first move to IN_PROGRESS records when work actually started.
  if (c.status === TaskStatus.IN_PROGRESS && existing.status !== TaskStatus.IN_PROGRESS && !existing.startedAt) data.startedAt = opts.startedAt ?? new Date();

  const dueDate = c.dueDate !== undefined ? c.dueDate : existing.dueDate;
  const dueTime = c.dueTime !== undefined ? c.dueTime : existing.dueTime;
  if (c.dueDate !== undefined || c.dueTime !== undefined) data.dueAt = computeDueAt(dueDate, dueTime, ctx.tz);
  data.version = existing.version + 1;
  data.deviceId = ctx.deviceId ?? null;
  data.lastModifiedAt = opts.clientModifiedAt ?? new Date();

  const updated = await prisma.task.update({ where: { id: taskId }, data });
  await recordVersion(updated, ctx.deviceId);
  // FR-RN-004: a new slot gets fresh copy and the old slot's check-ins are cancelled; done/skipped tasks lose theirs.
  if (updated.scheduledStart?.getTime() !== existing.scheduledStart?.getTime()) {
    await cancelCheckins(updated.id, updated.scheduledStart);
    if (updated.scheduledStart) refreshCheckinCopy(updated);
  }
  if (updated.status !== existing.status && (updated.status === TaskStatus.COMPLETED || updated.status === TaskStatus.SKIPPED)) await cancelCheckins(updated.id);

  if (updated.status === TaskStatus.COMPLETED && existing.status !== TaskStatus.COMPLETED) {
    logEvent(ctx.userId, "TASK_COMPLETED", updated.id, completionPayload(updated, ctx.tz));
  } else if (updated.status === TaskStatus.SKIPPED && existing.status !== TaskStatus.SKIPPED) {
    logEvent(ctx.userId, "TASK_SKIPPED", updated.id, { category: updated.category });
  } else {
    logEvent(ctx.userId, "TASK_UPDATED", updated.id, { fields: Object.keys(c) });
  }

  if (!opts.skipChildren && c.dueDate !== undefined && existing.dueDate && updated.dueDate) {
    const deltaMs = updated.dueDate.getTime() - existing.dueDate.getTime();
    if (deltaMs !== 0) await shiftChildren(ctx, updated.id, deltaMs);
  }
  if (existing.parentTaskId && existing.parentTaskId !== updated.parentTaskId) await updateParentProgress(existing.parentTaskId);
  if (updated.parentTaskId && (c.status !== undefined || c.progress !== undefined || c.parentTaskId !== undefined)) {
    await updateParentProgress(updated.parentTaskId);
  }
  return updated;
}

async function shiftChildren(ctx: TaskContext, parentId: string, deltaMs: number): Promise<void> {
  const children = await prisma.task.findMany({ where: { parentTaskId: parentId, userId: ctx.userId, status: { in: ACTIVE } } });
  for (const child of children) {
    await updateTask(ctx, child.id, {
      dueDate: child.dueDate ? new Date(child.dueDate.getTime() + deltaMs) : null,
      scheduledStart: child.scheduledStart ? new Date(child.scheduledStart.getTime() + deltaMs) : null,
      scheduledEnd: child.scheduledEnd ? new Date(child.scheduledEnd.getTime() + deltaMs) : null,
    });
  }
}

/** Parent progress = average of children; parent completes automatically when all children do. */
export async function updateParentProgress(parentTaskId: string | null, depth = 0): Promise<void> {
  if (!parentTaskId || depth > 5) return;
  const children = await prisma.task.findMany({
    where: { parentTaskId, status: { notIn: [TaskStatus.DELETED, TaskStatus.SKIPPED] } },
    select: { progress: true, status: true },
  });
  if (!children.length) return;
  const progress = Math.round(
    children.reduce((sum, child) => sum + (child.status === TaskStatus.COMPLETED ? 100 : child.progress), 0) / children.length,
  );
  const parent = await prisma.task.findUnique({ where: { id: parentTaskId } });
  if (!parent || parent.status === TaskStatus.DELETED) return;
  const status =
    progress === 100 ? TaskStatus.COMPLETED : progress > 0 ? TaskStatus.IN_PROGRESS : parent.status === TaskStatus.COMPLETED ? TaskStatus.IN_PROGRESS : parent.status;
  if (parent.progress === progress && parent.status === status) return;
  const updated = await prisma.task.update({
    where: { id: parentTaskId },
    data: {
      progress,
      status,
      completedAt: status === TaskStatus.COMPLETED ? (parent.completedAt ?? new Date()) : null,
      version: parent.version + 1,
      lastModifiedAt: new Date(),
    },
  });
  await recordVersion(updated, null);
  if (status === TaskStatus.COMPLETED && parent.status !== TaskStatus.COMPLETED) {
    logEvent(parent.userId, "TASK_COMPLETED", parent.id, { category: parent.category, viaSubtasks: true });
  }
  await updateParentProgress(parent.parentTaskId, depth + 1);
}

/** Soft delete (FR-TM-005): recoverable for 24 hours, then purged by the maintenance job. */
export async function softDeleteTask(ctx: TaskContext, taskId: string): Promise<Task | null> {
  const existing = await prisma.task.findFirst({ where: { id: taskId, userId: ctx.userId, status: { not: TaskStatus.DELETED } } });
  if (!existing) return null;
  const deleted = await prisma.task.update({
    where: { id: taskId },
    data: {
      status: TaskStatus.DELETED,
      deletedAt: new Date(),
      version: existing.version + 1,
      deviceId: ctx.deviceId ?? null,
      lastModifiedAt: new Date(),
    },
  });
  await cancelCheckins(deleted.id);
  await recordVersion(deleted, ctx.deviceId);
  logEvent(ctx.userId, "TASK_DELETED", taskId, { category: existing.category });
  if (existing.parentTaskId) await updateParentProgress(existing.parentTaskId);
  return deleted;
}

export async function restoreTask(ctx: TaskContext, taskId: string): Promise<Task | null> {
  const task = await prisma.task.findFirst({
    where: { id: taskId, userId: ctx.userId, status: TaskStatus.DELETED, deletedAt: { gte: new Date(Date.now() - 86400000) } },
  });
  if (!task) return null;
  const before = await prisma.taskVersion.findFirst({
    where: { taskId, version: { lt: task.version } },
    orderBy: { version: "desc" },
  });
  const prevStatus = (before?.snapshot as Record<string, unknown> | undefined)?.status;
  const status =
    typeof prevStatus === "string" && prevStatus !== TaskStatus.DELETED && prevStatus in TaskStatus
      ? (prevStatus as TaskStatus)
      : TaskStatus.PENDING;
  const restored = await prisma.task.update({
    where: { id: taskId },
    data: { status, deletedAt: null, version: task.version + 1, deviceId: ctx.deviceId ?? null, lastModifiedAt: new Date() },
  });
  await recordVersion(restored, ctx.deviceId);
  if (restored.parentTaskId) await updateParentProgress(restored.parentTaskId);
  return restored;
}

/** Undo the most recent edit (FR-TM-004 §5) — available for 15 minutes after the change. */
export async function undoLastEdit(ctx: TaskContext, taskId: string): Promise<Task | null> {
  const task = await prisma.task.findFirst({ where: { id: taskId, userId: ctx.userId } });
  if (!task || task.version < 2) return null;
  const [latest, previous] = await prisma.taskVersion.findMany({
    where: { taskId, version: { lte: task.version } },
    orderBy: { version: "desc" },
    take: 2,
  });
  if (!latest || !previous || latest.createdAt.getTime() < Date.now() - 15 * 60000) return null;
  const changes = changesFromSnapshot(previous.snapshot as Record<string, unknown>);
  if (task.status === TaskStatus.DELETED) return restoreTask(ctx, taskId);
  return updateTask(ctx, taskId, changes);
}

/** Splits a task into named subtasks (FR-TM-007 §3). Duration is divided evenly. */
export async function splitTask(
  ctx: TaskContext,
  taskId: string,
  parts: Array<{ title: string; durationMinutes?: number | null; scheduledStart?: Date | null; scheduledEnd?: Date | null }>,
): Promise<{ parent: Task; children: Task[] } | null> {
  const parent = await getTaskForUser(ctx.userId, taskId);
  if (!parent || !parts.length) return null;
  const share = parent.durationMinutes ? Math.max(5, Math.round(parent.durationMinutes / parts.length)) : null;
  const children: Task[] = [];
  for (const part of parts) {
    children.push(
      await createTask(ctx, {
        title: part.title,
        priority: parent.priority,
        category: parent.category,
        source: TaskSource.ASSISTANT,
        parentTaskId: parent.id,
        dueDate: parent.dueDate,
        dueTime: parent.dueTime,
        durationMinutes: part.durationMinutes ?? share,
        difficulty: parent.difficulty,
        taskType: parent.taskType === TaskType.FIXED ? TaskType.FLEXIBLE : parent.taskType,
        tags: Array.isArray(parent.tags) ? (parent.tags as string[]) : null,
        locationContext: parent.locationContext,
        scheduledStart: part.scheduledStart ?? null,
        scheduledEnd: part.scheduledEnd ?? null,
      }),
    );
  }
  const refreshed = (await getTaskForUser(ctx.userId, taskId)) ?? parent;
  return { parent: refreshed, children };
}

export async function listSubtasks(userId: string, parentTaskId: string): Promise<Task[]> {
  return prisma.task.findMany({
    where: { userId, parentTaskId, status: { not: TaskStatus.DELETED } },
    orderBy: [{ scheduledStart: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  });
}

export async function knownTags(userId: string): Promise<Array<{ tag: string; count: number }>> {
  const tasks = await prisma.task.findMany({
    where: { userId, status: { not: TaskStatus.DELETED }, NOT: { tags: { equals: Prisma.AnyNull } } },
    select: { tags: true },
  });
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (!Array.isArray(task.tags)) continue;
    for (const tag of task.tags) if (typeof tag === "string") counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
}

/** Removes a tag from every task (tag management — "delete unused tags"). */
export async function removeTagEverywhere(ctx: TaskContext, tag: string): Promise<number> {
  const normalized = tag.trim().toLowerCase();
  const tasks = await prisma.task.findMany({
    where: { userId: ctx.userId, status: { not: TaskStatus.DELETED }, NOT: { tags: { equals: Prisma.AnyNull } } },
  });
  let count = 0;
  for (const task of tasks) {
    if (!Array.isArray(task.tags) || !(task.tags as string[]).includes(normalized)) continue;
    await updateTask(ctx, task.id, { tags: (task.tags as string[]).filter((t) => t !== normalized) });
    count += 1;
  }
  return count;
}

/** Recomputes dueAt for all tasks after a timezone change. */
export async function recomputeDueAts(userId: string, tz: string): Promise<void> {
  const tasks = await prisma.task.findMany({ where: { userId, dueDate: { not: null }, status: { in: ACTIVE } } });
  for (const task of tasks) {
    const dueAt = computeDueAt(task.dueDate, task.dueTime, tz);
    if (dueAt?.getTime() !== task.dueAt?.getTime()) {
      await prisma.task.update({ where: { id: task.id }, data: { dueAt } });
    }
  }
}
