import { Priority, TaskSource, TaskStatus, type Task } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db.js";
import { handle, parseBody, requireUser } from "../../lib/http.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendSuccess } from "../../utils/apiResponse.js";
import {
  createTask,
  serializeTask,
  snapshotOf,
  softDeleteTask,
  TASK_FIELDS,
  updateTask,
  type TaskChanges,
  type TaskContext,
} from "../tasks/taskService.js";
import { toChanges } from "../tasks/taskRoutes.js";

/**
 * Offline-first sync (FR-MS-001..004, FR-EH-002).
 *  - creates are idempotent via the client id → no duplicates after interrupted syncs
 *  - updates carry the base version they were made on; if the server moved on, fields are
 *    merged: fields only one side changed are kept, true conflicts resolve last-write-wins
 *  - the response carries every task changed since the client's last pull
 */

const changesSchema = z.record(z.unknown());

const mutationSchema = z.object({
  mutationId: z.string().min(1).max(100),
  op: z.enum(["create", "update", "delete"]),
  localId: z.string().max(80).optional(),
  taskId: z.string().max(80).optional(),
  baseVersion: z.number().int().positive().optional(),
  changes: changesSchema.optional(),
  clientModifiedAt: z.string().refine((v) => !Number.isNaN(Date.parse(v))).optional(),
});

type Result = {
  mutationId: string;
  status: "applied" | "merged" | "conflict_resolved_server" | "rejected";
  localId?: string;
  task?: ReturnType<typeof serializeTask>;
  error?: string;
};

const updateShape = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(5000).nullable().optional(),
  dueDate: z.string().nullable().optional(),
  dueTime: z.string().max(20).nullable().optional(),
  priority: z.nativeEnum(Priority).optional(),
  category: z.string().max(60).nullable().optional(),
  status: z.nativeEnum(TaskStatus).optional(),
  parentTaskId: z.string().uuid().nullable().optional(),
  progress: z.number().int().min(0).max(100).optional(),
  durationMinutes: z.number().int().positive().nullable().optional(),
  difficulty: z.number().int().min(1).max(5).nullable().optional(),
  archived: z.boolean().optional(),
  tags: z.array(z.string()).nullable().optional(),
  locationContext: z.string().max(100).nullable().optional(),
  reminderMinutes: z.number().int().nonnegative().nullable().optional(),
  scheduledStart: z.string().nullable().optional(),
  scheduledEnd: z.string().nullable().optional(),
});

function pickKnown(changes: Record<string, unknown>): z.infer<typeof updateShape> {
  const known: Record<string, unknown> = {};
  for (const key of Object.keys(changes)) if ((TASK_FIELDS as readonly string[]).includes(key)) known[key] = changes[key];
  const parsed = updateShape.safeParse(known);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "invalid changes");
  return parsed.data;
}

/**
 * Field-level merge for an update made on an older version (pure; no I/O).
 *  - no base snapshot (history purged) → every incoming field applies
 *  - a field only the client changed → applies
 *  - a field both sides changed (true conflict) → newer modification time wins (device clocks)
 */
export function mergeFields(
  incoming: Record<string, unknown>,
  baseSnapshot: Record<string, unknown> | null,
  current: Record<string, unknown>,
  clientModifiedAt: Date,
  serverModifiedAt: Date,
): { merged: Record<string, unknown>; dropped: string[]; clientWins: boolean } {
  const serverChanged = new Set(
    TASK_FIELDS.filter((f) => baseSnapshot && JSON.stringify(baseSnapshot[f] ?? null) !== JSON.stringify(current[f] ?? null)),
  );
  const clientWins = clientModifiedAt > serverModifiedAt;
  const merged: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [field, value] of Object.entries(incoming)) {
    if (!baseSnapshot || !serverChanged.has(field as (typeof TASK_FIELDS)[number]) || clientWins) merged[field] = value;
    else dropped.push(field);
  }
  return { merged, dropped, clientWins };
}

/** What to do with an update/delete mutation given the task's current server state (pure). */
export function mutationAction(op: "update" | "delete", task: Pick<Task, "status"> | null): "reject" | "delete" | "already_deleted" | "keep_deleted" | "merge" {
  if (!task) return "reject";
  if (op === "delete") return task.status === TaskStatus.DELETED ? "already_deleted" : "delete";
  return task.status === TaskStatus.DELETED ? "keep_deleted" : "merge";
}

async function mergeUpdate(ctx: TaskContext, task: Task, incoming: TaskChanges, baseVersion: number | undefined, clientModifiedAt: Date): Promise<{ task: Task | null; status: Result["status"] }> {
  if (!baseVersion || baseVersion >= task.version) {
    return { task: await updateTask(ctx, task.id, incoming, { clientModifiedAt }), status: "applied" };
  }
  const base = await prisma.taskVersion.findUnique({ where: { taskId_version: { taskId: task.id, version: baseVersion } } });
  const { merged, dropped, clientWins } = mergeFields(
    incoming as Record<string, unknown>,
    base ? ((base.snapshot ?? {}) as Record<string, unknown>) : null,
    snapshotOf(task),
    clientModifiedAt,
    task.lastModifiedAt,
  );
  if (!Object.keys(merged).length) return { task, status: "conflict_resolved_server" };
  const updated = await updateTask(ctx, task.id, merged as TaskChanges, { clientModifiedAt: clientWins ? clientModifiedAt : task.lastModifiedAt });
  return { task: updated, status: dropped.length ? "merged" : "applied" };
}

export const syncRouter = Router();
syncRouter.use(requireFirebaseUser, requireUser);

syncRouter.post(
  "/",
  handle(async (req, res) => {
    const body = parseBody(
      z.object({ mutations: z.array(mutationSchema).max(200).default([]), since: z.string().optional().nullable() }),
      req.body,
    );
    const ctx: TaskContext = { userId: req.user.id, tz: req.settings.timezone, deviceId: req.deviceId };
    const results: Result[] = [];
    const localToServer = new Map<string, string>();

    for (const m of body.mutations) {
      try {
        const clientModifiedAt = m.clientModifiedAt ? new Date(m.clientModifiedAt) : new Date();
        if (m.op === "create") {
          const raw = (m.changes ?? {}) as Record<string, unknown>;
          const c = pickKnown(raw);
          const task = await createTask(ctx, {
            ...toChanges({ ...c, priority: c.priority ?? Priority.MEDIUM, title: c.title ?? "Untitled task" }),
            title: c.title ?? "Untitled task",
            priority: c.priority ?? Priority.MEDIUM,
            source: Object.values(TaskSource).includes(raw.source as TaskSource) ? (raw.source as TaskSource) : TaskSource.MANUAL,
            confidence: typeof raw.confidence === "number" ? raw.confidence : null,
            clientId: m.localId ?? m.mutationId,
          });
          if (m.localId) localToServer.set(m.localId, task.id);
          results.push({ mutationId: m.mutationId, status: "applied", localId: m.localId, task: serializeTask(task) });
          continue;
        }
        const id = m.taskId ? (localToServer.get(m.taskId) ?? m.taskId) : undefined;
        let task = id ? await prisma.task.findFirst({ where: { id, userId: req.user.id } }) : null;
        if (!task && m.taskId) task = await prisma.task.findFirst({ where: { userId: req.user.id, clientId: m.taskId } });
        const action = mutationAction(m.op, task);
        if (action === "reject" || !task) {
          results.push({ mutationId: m.mutationId, status: "rejected", error: "Task not found" });
          continue;
        }
        if (action === "delete" || action === "already_deleted") {
          const deleted = action === "already_deleted" ? task : await softDeleteTask(ctx, task.id);
          results.push({ mutationId: m.mutationId, status: "applied", task: deleted ? serializeTask(deleted) : undefined });
          continue;
        }
        if (action === "keep_deleted") {
          results.push({ mutationId: m.mutationId, status: "conflict_resolved_server", task: serializeTask(task) });
          continue;
        }
        const merged = await mergeUpdate(ctx, task, toChanges(pickKnown(m.changes ?? {})), m.baseVersion, clientModifiedAt);
        results.push({ mutationId: m.mutationId, status: merged.status, task: merged.task ? serializeTask(merged.task) : undefined });
      } catch (error) {
        results.push({ mutationId: m.mutationId, status: "rejected", error: error instanceof Error ? error.message : "failed" });
      }
    }

    const since = body.since && !Number.isNaN(Date.parse(body.since)) ? new Date(body.since) : null;
    const changed = await prisma.task.findMany({
      where: { userId: req.user.id, ...(since ? { updatedAt: { gt: since } } : { status: { not: TaskStatus.DELETED } }) },
      orderBy: { updatedAt: "asc" },
      take: 2000,
    });
    const now = new Date();
    sendSuccess(res, { results, changes: changed.map((t) => serializeTask(t, now)), serverTime: now.toISOString(), full: !since });
  }),
);
