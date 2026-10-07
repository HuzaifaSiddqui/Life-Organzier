import { Priority } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { handle, parseBody, requireUser } from "../../lib/http.js";
import { localYmd } from "../../lib/time.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendSuccess } from "../../utils/apiResponse.js";
import { dayLoad, dayPlan, loadScheduleContext, suggestSlot } from "./schedulingService.js";

export const schedulingRouter = Router();
schedulingRouter.use(requireFirebaseUser, requireUser);

schedulingRouter.get(
  "/day",
  handle(async (req, res) => {
    const ymd = typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : localYmd(new Date(), req.settings.timezone);
    sendSuccess(res, { plan: await dayPlan(req.user.id, req.settings, ymd) });
  }),
);

schedulingRouter.post(
  "/suggest",
  handle(async (req, res) => {
    const body = parseBody(
      z.object({
        durationMinutes: z.number().int().positive().max(720),
        priority: z.nativeEnum(Priority).default(Priority.MEDIUM),
        difficulty: z.number().int().min(1).max(5).nullable().optional(),
        deadline: z.string().nullable().optional(),
        preferredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      }),
      req.body,
    );
    const ctx = await loadScheduleContext(req.user.id, req.settings, 14);
    const slot = suggestSlot(ctx, {
      durationMinutes: body.durationMinutes,
      priority: body.priority,
      difficulty: body.difficulty ?? null,
      deadline: body.deadline && !Number.isNaN(Date.parse(body.deadline)) ? new Date(body.deadline) : null,
      preferredYmd: body.preferredDate ?? null,
    });
    const load = body.preferredDate ? dayLoad(ctx, body.preferredDate) : null;
    sendSuccess(res, { slot, load });
  }),
);
