import { Priority, ReminderMode, TaskSource, TaskStatus, TaskType } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db.js";
import { handle, HttpError, parseBody, requireUser, type UserRequest } from "../../lib/http.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendSuccess } from "../../utils/apiResponse.js";
import { suggestCategory, suggestTags } from "../assistant/entities.js";
import { proposeSubtasks } from "../assistant/responder.js";
import { loadScheduleContext, suggestSlot } from "../scheduling/schedulingService.js";
import {
  createTask,
  getTaskForUser,
  listSubtasks,
  listTasksForUser,
  restoreTask,
  serializeTask,
  softDeleteTask,
  splitTask,
  undoLastEdit,
  updateTask,
  type TaskChanges,
  type TaskContext,
} from "./taskService.js";

export const taskRouter = Router();
taskRouter.use(requireFirebaseUser, requireUser);

const isoOrNull = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "invalid date")
  .nullable()
  .optional();

const editable = {
  title: z.string().trim().min(1).max(300),
  description: z.string().max(5000).nullable().optional(),
  dueDate: isoOrNull,
  dueTime: z.string().max(20).nullable().optional(),
  priority: z.nativeEnum(Priority),
  category: z.string().max(60).nullable().optional(),
  status: z.nativeEnum(TaskStatus).optional(),
  parentTaskId: z.string().uuid().nullable().optional(),
  progress: z.number().int().min(0).max(100).optional(),
  durationMinutes: z.number().int().positive().max(24 * 60).nullable().optional(),
  difficulty: z.number().int().min(1).max(5).nullable().optional(),
  taskType: z.nativeEnum(TaskType).optional(),
  archived: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(20).nullable().optional(),
  locationContext: z.string().max(100).nullable().optional(),
  reminderMinutes: z.number().int().nonnegative().max(60 * 24 * 14).nullable().optional(),
  reminderMode: z.nativeEnum(ReminderMode).optional(),
  scheduledStart: isoOrNull,
  scheduledEnd: isoOrNull,
};

const createSchema = z.object({
  ...editable,
  source: z.nativeEnum(TaskSource).default(TaskSource.MANUAL),
  confidence: z.number().int().min(0).max(100).nullable().optional(),
  clientId: z.string().max(80).nullable().optional(),
});

const updateSchema = z.object({ ...editable, title: editable.title.optional(), priority: editable.priority.optional() });

function ctxOf(req: UserRequest): TaskContext {
  return { userId: req.user.id, tz: req.settings.timezone, deviceId: req.deviceId };
}

function toDate(v: string | null | undefined): Date | null | undefined {
  if (v === undefined) return undefined;
  return v === null ? null : new Date(v);
}

export function toChanges(body: z.infer<typeof updateSchema>): TaskChanges {
  const { dueDate, scheduledStart, scheduledEnd, ...rest } = body;
  const changes: TaskChanges = { ...rest };
  if (dueDate !== undefined) changes.dueDate = toDate(dueDate);
  if (scheduledStart !== undefined) changes.scheduledStart = toDate(scheduledStart);
  if (scheduledEnd !== undefined) changes.scheduledEnd = toDate(scheduledEnd);
  return changes;
}

taskRouter.get(
  "/",
  handle(async (req, res) => {
    const includeArchived = req.query.includeArchived === "true";
    const tasks = await listTasksForUser(req.user.id, { includeArchived });
    const now = new Date();
    sendSuccess(res, { tasks: tasks.map((t) => serializeTask(t, now)), serverTime: now.toISOString() });
  }),
);

taskRouter.get(
  "/deleted",
  handle(async (req, res) => {
    const tasks = await prisma.task.findMany({
      where: { userId: req.user.id, status: TaskStatus.DELETED, deletedAt: { gte: new Date(Date.now() - 86400000) } },
      orderBy: { deletedAt: "desc" },
    });
    sendSuccess(res, { tasks: tasks.map((t) => serializeTask(t)) });
  }),
);

taskRouter.post(
  "/suggest",
  handle(async (req, res) => {
    const { text } = parseBody(z.object({ text: z.string().max(500) }), req.body);
    const custom = await prisma.category.findMany({ where: { userId: req.user.id }, select: { name: true } });
    sendSuccess(res, { category: suggestCategory(text, custom.map((c) => c.name)), tags: suggestTags(text) });
  }),
);

taskRouter.post(
  "/",
  handle(async (req, res) => {
    const b = parseBody(createSchema, req.body);
    const changes = toChanges(b);
    const task = await createTask(ctxOf(req), {
      ...changes,
      title: b.title,
      priority: b.priority,
      source: b.source,
      confidence: b.confidence ?? null,
      clientId: b.clientId ?? null,
    });
    sendSuccess(res, { task: serializeTask(task) }, "Task created successfully", 201);
  }),
);

taskRouter.get(
  "/:id",
  handle(async (req, res) => {
    const task = await getTaskForUser(req.user.id, req.params.id);
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    const subtasks = await listSubtasks(req.user.id, task.id);
    const parent = task.parentTaskId ? await getTaskForUser(req.user.id, task.parentTaskId) : null;
    sendSuccess(res, {
      task: serializeTask(task),
      subtasks: subtasks.map((t) => serializeTask(t)),
      parent: parent ? { id: parent.id, title: parent.title } : null,
      canUndo: task.version > 1 && task.updatedAt.getTime() > Date.now() - 15 * 60000,
    });
  }),
);

taskRouter.put(
  "/:id",
  handle(async (req, res) => {
    const b = parseBody(updateSchema, req.body);
    const task = await updateTask(ctxOf(req), req.params.id, toChanges(b));
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    sendSuccess(res, { task: serializeTask(task) }, "Task updated successfully");
  }),
);

taskRouter.patch(
  "/:id/status",
  handle(async (req, res) => {
    const { status } = parseBody(z.object({ status: z.nativeEnum(TaskStatus) }), req.body);
    if (status === TaskStatus.DELETED) throw new HttpError(400, "VALIDATION_ERROR", "Use DELETE to remove a task");
    const task = await updateTask(ctxOf(req), req.params.id, { status });
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    sendSuccess(res, { task: serializeTask(task) }, "Task status updated");
  }),
);

taskRouter.patch(
  "/:id/progress",
  handle(async (req, res) => {
    const { progress } = parseBody(z.object({ progress: z.number().int().min(0).max(100) }), req.body);
    const task = await updateTask(ctxOf(req), req.params.id, { progress });
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    sendSuccess(res, { task: serializeTask(task) }, task.status === TaskStatus.COMPLETED ? "Task completed" : "Progress updated");
  }),
);

taskRouter.post(
  "/:id/undo",
  handle(async (req, res) => {
    const task = await undoLastEdit(ctxOf(req), req.params.id);
    if (!task) throw new HttpError(409, "UNDO_UNAVAILABLE", "Nothing recent to undo for this task");
    sendSuccess(res, { task: serializeTask(task) }, "Change undone");
  }),
);

taskRouter.post(
  "/:id/restore",
  handle(async (req, res) => {
    const task = await restoreTask(ctxOf(req), req.params.id);
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task cannot be restored after 24 hours");
    sendSuccess(res, { task: serializeTask(task) }, "Task restored");
  }),
);

taskRouter.post(
  "/:id/split",
  handle(async (req, res) => {
    const body = parseBody(
      z.object({
        parts: z.array(z.object({ title: z.string().trim().min(1).max(200), durationMinutes: z.number().int().positive().nullable().optional() })).max(12).optional(),
        count: z.number().int().min(2).max(8).optional(),
      }),
      req.body,
    );
    const task = await getTaskForUser(req.user.id, req.params.id);
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    let parts = body.parts ?? [];
    if (!parts.length) {
      const count = body.count ?? 3;
      const names = (await proposeSubtasks(task.title, count)) ?? Array.from({ length: count }, (_, i) => `Part ${i + 1}`);
      parts = names.map((title) => ({ title, durationMinutes: null }));
    }
    const result = await splitTask(ctxOf(req), task.id, parts);
    if (!result) throw new HttpError(400, "SPLIT_FAILED", "Could not split task");
    sendSuccess(res, { task: serializeTask(result.parent), subtasks: result.children.map((c) => serializeTask(c)) }, "Task split");
  }),
);

taskRouter.get(
  "/:id/suggest-slot",
  handle(async (req, res) => {
    const task = await getTaskForUser(req.user.id, req.params.id);
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    const ctx = await loadScheduleContext(req.user.id, req.settings, 14);
    const slot = suggestSlot(ctx, {
      durationMinutes: task.durationMinutes ?? 60,
      priority: task.priority,
      difficulty: task.difficulty,
      deadline: task.dueAt,
      excludeTaskId: task.id,
    });
    sendSuccess(res, { slot });
  }),
);

taskRouter.delete(
  "/:id",
  handle(async (req, res) => {
    const task = await softDeleteTask(ctxOf(req), req.params.id);
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    sendSuccess(res, { task: serializeTask(task) }, "Task deleted — you can undo for 24 hours");
  }),
);
