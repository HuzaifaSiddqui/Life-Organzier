import { RoutineFrequency, RoutineOccurrenceStatus, RoutinePriority } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { handle, HttpError, parseBody, requireUser } from "../../lib/http.js";
import { localYmd, parseClock } from "../../lib/time.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendSuccess } from "../../utils/apiResponse.js";
import {
  createRoutine,
  deleteRoutine,
  generateRoutineOccurrences,
  listRoutines,
  markMissedOccurrences,
  occurrencesForDay,
  rescheduleOccurrence,
  updateOccurrence,
  updateRoutine,
} from "./routineService.js";

export const routineRouter = Router();
routineRouter.use(requireFirebaseUser, requireUser);

const base = {
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  frequency: z.nativeEnum(RoutineFrequency),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
  dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
  dueTime: z.string().refine((v) => parseClock(v) !== null, "invalid time").nullable().optional(),
  durationMinutes: z.number().int().positive().max(24 * 60).nullable().optional(),
  category: z.string().max(60).nullable().optional(),
  priority: z.nativeEnum(RoutinePriority).default(RoutinePriority.NORMAL),
  timeLocked: z.boolean().default(false),
  locationContext: z.string().max(60).nullable().optional(),
  wellnessType: z.string().max(40).nullable().optional(),
};

routineRouter.get(
  "/",
  handle(async (req, res) => {
    const tz = req.settings.timezone;
    const all = req.query.all === "true";
    await markMissedOccurrences(req.user.id, tz);
    await generateRoutineOccurrences(req.user.id, tz);
    const routines = await listRoutines(req.user.id, tz, all ? null : req.settings.currentContext);
    sendSuccess(res, { routines, context: req.settings.currentContext });
  }),
);

routineRouter.get(
  "/today",
  handle(async (req, res) => {
    const tz = req.settings.timezone;
    await markMissedOccurrences(req.user.id, tz);
    await generateRoutineOccurrences(req.user.id, tz);
    const ymd = typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : localYmd(new Date(), tz);
    sendSuccess(res, { date: ymd, occurrences: await occurrencesForDay(req.user.id, tz, ymd, req.settings.currentContext) });
  }),
);

routineRouter.post(
  "/",
  handle(async (req, res) => {
    const body = parseBody(z.object(base), req.body);
    const routine = await createRoutine(req.user.id, req.settings.timezone, body);
    sendSuccess(res, { routine }, "Routine created", 201);
  }),
);

routineRouter.put(
  "/:id",
  handle(async (req, res) => {
    const body = parseBody(z.object({ ...base, active: z.boolean() }).partial(), req.body);
    const routine = await updateRoutine(req.user.id, req.settings.timezone, req.params.id, body);
    if (!routine) throw new HttpError(404, "ROUTINE_NOT_FOUND", "Routine not found");
    sendSuccess(res, { routine }, "Routine updated");
  }),
);

routineRouter.delete(
  "/:id",
  handle(async (req, res) => {
    if (!(await deleteRoutine(req.user.id, req.params.id))) throw new HttpError(404, "ROUTINE_NOT_FOUND", "Routine not found");
    sendSuccess(res, {}, "Routine deleted");
  }),
);

routineRouter.patch(
  "/occurrences/:id",
  handle(async (req, res) => {
    const body = parseBody(
      z.object({ status: z.nativeEnum(RoutineOccurrenceStatus), confirmMandatory: z.boolean().optional() }),
      req.body,
    );
    const occurrence = await updateOccurrence(req.user.id, req.params.id, body.status, { confirmMandatory: body.confirmMandatory });
    if (!occurrence) throw new HttpError(404, "OCCURRENCE_NOT_FOUND", "Occurrence not found");
    sendSuccess(res, { occurrence }, "Occurrence updated");
  }),
);

routineRouter.post(
  "/occurrences/:id/reschedule",
  handle(async (req, res) => {
    const body = parseBody(
      z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().refine((v) => parseClock(v) !== null).nullable().optional() }),
      req.body,
    );
    const occurrence = await rescheduleOccurrence(req.user.id, req.settings.timezone, req.params.id, body.date, body.time ?? null);
    if (!occurrence) throw new HttpError(404, "OCCURRENCE_NOT_FOUND", "Occurrence not found");
    sendSuccess(res, { occurrence }, "Occurrence rescheduled");
  }),
);
