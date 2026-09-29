import { Priority, TaskSource, TaskStatus } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import type { AuthRequest } from "../../middleware/authMiddleware.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendError, sendSuccess } from "../../utils/apiResponse.js";
import { getUserByFirebaseUid } from "../users/userService.js";
import {
  createTask,
  deleteTask,
  getTaskForUser,
  listTasksForUser,
  setTaskStatus,
  updateTask,
} from "./taskService.js";

export const taskRouter = Router();

const createBody = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  dueDate: z.string().optional().nullable(),
  dueTime: z.string().optional().nullable(),
  priority: z.nativeEnum(Priority),
  category: z.string().optional().nullable(),
  status: z.nativeEnum(TaskStatus).optional(),
  source: z.nativeEnum(TaskSource),
  confidence: z.number().int().min(0).max(100).optional().nullable(),
});

const updateBody = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  dueDate: z.string().optional().nullable(),
  dueTime: z.string().optional().nullable(),
  priority: z.nativeEnum(Priority).optional(),
  category: z.string().optional().nullable(),
  status: z.nativeEnum(TaskStatus).optional(),
});

const statusBody = z.object({
  status: z.nativeEnum(TaskStatus),
});

async function requireDbUser(req: AuthRequest, res: import("express").Response) {
  const uid = req.firebase?.uid;
  if (!uid) {
    sendError(res, "Unauthorized", "UNAUTHORIZED", 401);
    return null;
  }
  try {
    const user = await getUserByFirebaseUid(uid);
    if (!user) {
      sendError(res, "User not found. Call sync-user first.", "USER_NOT_FOUND", 404);
      return null;
    }
    return user;
  } catch (error) {
    console.error("Could not load database user", error);
    sendError(res, "Database is temporarily unavailable", "DATABASE_UNAVAILABLE", 503);
    return null;
  }
}

taskRouter.use(requireFirebaseUser);

taskRouter.post("/", async (req: AuthRequest, res) => {
  const user = await requireDbUser(req, res);
  if (!user) return;

  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Invalid request body", "VALIDATION_ERROR", 400);
    return;
  }

  const b = parsed.data;
  try {
    const task = await createTask({
      userId: user.id,
      title: b.title,
      description: b.description ?? null,
      dueDate: b.dueDate ? new Date(b.dueDate) : null,
      dueTime: b.dueTime ?? null,
      priority: b.priority,
      category: b.category ?? null,
      status: b.status ?? TaskStatus.PENDING,
      source: b.source,
      confidence: b.confidence ?? null,
    });
    sendSuccess(res, { task }, "Task created successfully", 201);
  } catch (e) {
    console.error(e);
    sendError(res, "Could not create task", "TASK_CREATE_FAILED", 500);
  }
});

taskRouter.get("/", async (req: AuthRequest, res) => {
  const user = await requireDbUser(req, res);
  if (!user) return;
  try {
    const tasks = await listTasksForUser(user.id);
    sendSuccess(res, { tasks });
  } catch (e) {
    console.error(e);
    sendError(res, "Could not load tasks", "TASK_LIST_FAILED", 500);
  }
});

taskRouter.get("/:id", async (req: AuthRequest, res) => {
  const user = await requireDbUser(req, res);
  if (!user) return;
  try {
    const task = await getTaskForUser(user.id, req.params.id);
    if (!task) {
      sendError(res, "Task not found", "TASK_NOT_FOUND", 404);
      return;
    }
    sendSuccess(res, { task });
  } catch (e) {
    console.error(e);
    sendError(res, "Could not load task", "TASK_GET_FAILED", 500);
  }
});

taskRouter.put("/:id", async (req: AuthRequest, res) => {
  const user = await requireDbUser(req, res);
  if (!user) return;
  const parsed = updateBody.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Invalid request body", "VALIDATION_ERROR", 400);
    return;
  }
  const b = parsed.data;
  try {
    const task = await updateTask(user.id, req.params.id, {
      ...b,
      dueDate: b.dueDate === undefined ? undefined : b.dueDate ? new Date(b.dueDate) : null,
    });
    if (!task) {
      sendError(res, "Task not found", "TASK_NOT_FOUND", 404);
      return;
    }
    sendSuccess(res, { task }, "Task updated successfully");
  } catch (e) {
    console.error(e);
    sendError(res, "Could not update task", "TASK_UPDATE_FAILED", 500);
  }
});

taskRouter.delete("/:id", async (req: AuthRequest, res) => {
  const user = await requireDbUser(req, res);
  if (!user) return;
  try {
    const ok = await deleteTask(user.id, req.params.id);
    if (!ok) {
      sendError(res, "Task not found", "TASK_NOT_FOUND", 404);
      return;
    }
    sendSuccess(res, {}, "Task deleted successfully");
  } catch (e) {
    console.error(e);
    sendError(res, "Could not delete task", "TASK_DELETE_FAILED", 500);
  }
});

taskRouter.patch("/:id/status", async (req: AuthRequest, res) => {
  const user = await requireDbUser(req, res);
  if (!user) return;
  const parsed = statusBody.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Invalid request body", "VALIDATION_ERROR", 400);
    return;
  }
  try {
    const task = await setTaskStatus(user.id, req.params.id, parsed.data.status);
    if (!task) {
      sendError(res, "Task not found", "TASK_NOT_FOUND", 404);
      return;
    }
    sendSuccess(res, { task }, "Task status updated");
  } catch (e) {
    console.error(e);
    sendError(res, "Could not update status", "TASK_STATUS_FAILED", 500);
  }
});
