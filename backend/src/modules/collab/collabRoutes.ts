import { Priority, SharedTaskKind, TaskType } from "@prisma/client";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { handle, HttpError, parseBody, requireUser, type UserRequest } from "../../lib/http.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendError, sendSuccess } from "../../utils/apiResponse.js";
import { serializeTask } from "../tasks/taskService.js";
import { collabOn } from "./collabRules.js";
import {
  acceptSharedTask,
  cancelSharedTask,
  collabSummary,
  createSharedTask,
  getSharedTask,
  listConnections,
  listNotices,
  listSharedTasks,
  markNoticesRead,
  rejectSharedTask,
  removeConnection,
  requestConnection,
  resendSharedTask,
  respondConnection,
  searchUsers,
  setUsername,
  updateSharedTask,
  type SharedTaskInput,
} from "./collabService.js";

/** Task collaboration (COLLAB_TASKS=on; otherwise every route is 404, so the app hides the feature). */
export const collabRouter = Router();
collabRouter.use((_req: Request, res: Response, next: NextFunction) => {
  if (!collabOn()) {
    sendError(res, "Not found", "NOT_FOUND", 404);
    return;
  }
  next();
});
collabRouter.use(requireFirebaseUser, requireUser);

const isoOrNull = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "invalid date")
  .nullable()
  .optional();
const toDate = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : new Date(v));

const details = {
  title: z.string().trim().min(1).max(300),
  description: z.string().max(5000).nullable().optional(),
  dueDate: isoOrNull,
  dueTime: z.string().max(20).nullable().optional(),
  priority: z.nativeEnum(Priority),
  category: z.string().max(60).nullable().optional(),
  durationMinutes: z.number().int().positive().max(24 * 60).nullable().optional(),
  taskType: z.nativeEnum(TaskType).optional(),
};
const createSchema = z.object({ ...details, kind: z.nativeEnum(SharedTaskKind), memberIds: z.array(z.string().uuid()).min(1).max(20) });
const updateSchema = z.object({ ...details, title: details.title.optional(), priority: details.priority.optional() });
const acceptSchema = z.object({ dueDate: isoOrNull, dueTime: z.string().max(20).nullable().optional() });

function inputOf(b: z.infer<typeof updateSchema>): Partial<SharedTaskInput> {
  const { dueDate, ...rest } = b;
  return { ...rest, ...(dueDate !== undefined ? { dueDate: toDate(dueDate) } : {}) };
}

const idParam = (req: UserRequest, key = "id") => {
  const v = req.params[key];
  if (!z.string().uuid().safeParse(v).success) throw new HttpError(404, "NOT_FOUND", "Not found");
  return v;
};

collabRouter.get("/me", handle(async (req, res) => sendSuccess(res, await collabSummary(req.user))));

collabRouter.put(
  "/username",
  handle(async (req, res) => {
    const { username } = parseBody(z.object({ username: z.string().max(40) }), req.body);
    sendSuccess(res, { username: await setUsername(req.user.id, username) });
  }),
);

collabRouter.get(
  "/users/search",
  handle(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    sendSuccess(res, { users: await searchUsers(req.user.id, q) });
  }),
);

collabRouter.get("/connections", handle(async (req, res) => sendSuccess(res, await listConnections(req.user.id))));

collabRouter.post(
  "/connections",
  handle(async (req, res) => {
    const { userId } = parseBody(z.object({ userId: z.string().uuid() }), req.body);
    sendSuccess(res, await requestConnection(req.user, userId));
  }),
);

collabRouter.post(
  "/connections/:id/accept",
  handle(async (req, res) => {
    await respondConnection(req.user, idParam(req), true);
    sendSuccess(res, { ok: true });
  }),
);

collabRouter.post(
  "/connections/:id/reject",
  handle(async (req, res) => {
    await respondConnection(req.user, idParam(req), false);
    sendSuccess(res, { ok: true });
  }),
);

/** 409 OPEN_SHARED_TASKS with the tasks to settle first. */
collabRouter.delete(
  "/connections/:id",
  handle(async (req, res) => {
    const result = await removeConnection(req.user, idParam(req));
    if (!result.removed) {
      res.status(409).json({ success: false, message: "Settle your shared tasks first.", error: "OPEN_SHARED_TASKS", data: { openTasks: result.openTasks } });
      return;
    }
    sendSuccess(res, { ok: true });
  }),
);

collabRouter.get("/tasks", handle(async (req, res) => sendSuccess(res, await listSharedTasks(req.user.id))));

collabRouter.post(
  "/tasks",
  handle(async (req, res) => {
    const b = parseBody(createSchema, req.body);
    const { kind, memberIds, ...rest } = b;
    const { shared, ownerTask } = await createSharedTask(req.user, req.settings.timezone, {
      ...(inputOf(rest) as SharedTaskInput),
      kind,
      memberIds,
      deviceId: req.deviceId,
    });
    sendSuccess(res, { shared, task: ownerTask ? serializeTask(ownerTask) : null }, "Shared", 201);
  }),
);

collabRouter.get("/tasks/:id", handle(async (req, res) => sendSuccess(res, { shared: await getSharedTask(req.user.id, idParam(req)) })));

collabRouter.patch(
  "/tasks/:id",
  handle(async (req, res) => {
    const b = parseBody(updateSchema, req.body);
    sendSuccess(res, { shared: await updateSharedTask(req.user, req.settings.timezone, idParam(req), inputOf(b), req.deviceId) });
  }),
);

collabRouter.post(
  "/tasks/:id/accept",
  handle(async (req, res) => {
    const b = parseBody(acceptSchema, req.body ?? {});
    const { shared, task } = await acceptSharedTask(req.user, req.settings.timezone, idParam(req), { dueDate: toDate(b.dueDate), dueTime: b.dueTime }, req.deviceId);
    sendSuccess(res, { shared, task: serializeTask(task) });
  }),
);

collabRouter.post(
  "/tasks/:id/reject",
  handle(async (req, res) => sendSuccess(res, { shared: await rejectSharedTask(req.user, req.settings.timezone, idParam(req), req.deviceId) })),
);

collabRouter.post(
  "/tasks/:id/resend",
  handle(async (req, res) => {
    const { userId } = parseBody(z.object({ userId: z.string().uuid() }), req.body);
    sendSuccess(res, { shared: await resendSharedTask(req.user, idParam(req), userId) });
  }),
);

collabRouter.delete("/tasks/:id", handle(async (req, res) => sendSuccess(res, { shared: await cancelSharedTask(req.user, idParam(req)) })));

collabRouter.get("/notices", handle(async (req, res) => sendSuccess(res, { notices: await listNotices(req.user.id) })));

collabRouter.post(
  "/notices/read",
  handle(async (req, res) => sendSuccess(res, { marked: await markNoticesRead(req.user.id) })),
);
