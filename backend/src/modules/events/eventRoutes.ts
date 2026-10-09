import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db.js";
import { handle, parseBody, requireUser } from "../../lib/http.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendSuccess } from "../../utils/apiResponse.js";
import { getEstimateSuggestion } from "../patterns/patternService.js";
import { logEvent } from "./eventService.js";

export const eventRouter = Router();
eventRouter.use(requireFirebaseUser, requireUser);

/** Client interaction tracking (app opens, screen use) for pattern learning. */
eventRouter.post(
  "/",
  handle(async (req, res) => {
    const body = parseBody(z.object({ type: z.enum(["APP_OPEN"]), payload: z.record(z.unknown()).optional() }), req.body);
    if (body.type === "APP_OPEN") {
      // Debounce: at most one app-open event per 10 minutes.
      const recent = await prisma.activityEvent.findFirst({
        where: { userId: req.user.id, type: "APP_OPEN", createdAt: { gte: new Date(Date.now() - 10 * 60000) } },
      });
      if (!recent) logEvent(req.user.id, "APP_OPEN", null, (body.payload ?? {}) as Record<string, string>);
    }
    sendSuccess(res, {}, "Recorded");
  }),
);

/** FR-RN-004 §6: adjusted duration for a category, if the user's own history supports one. */
eventRouter.get(
  "/estimate-suggestion",
  handle(async (req, res) => {
    const q = z.object({ category: z.string().min(1).max(60), minutes: z.coerce.number().int().min(1).max(1440) }).parse(req.query);
    sendSuccess(res, { suggestion: await getEstimateSuggestion(req.user.id, req.settings.timezone, q.category, q.minutes) }, "OK");
  }),
);

/** The phone reports when it showed / the user accepted a suggestion (the chat logs its own server-side). */
eventRouter.post(
  "/estimate-suggestion",
  handle(async (req, res) => {
    const b = parseBody(
      z.object({
        action: z.enum(["SHOWN", "ACCEPTED"]),
        taskId: z.string().max(64).nullish(),
        category: z.string().max(60),
        original: z.number().int(),
        suggested: z.number().int(),
      }),
      req.body,
    );
    logEvent(req.user.id, b.action === "SHOWN" ? "ESTIMATE_SUGGESTION_SHOWN" : "ESTIMATE_SUGGESTION_ACCEPTED", b.taskId ?? null, {
      category: b.category,
      original: b.original,
      suggested: b.suggested,
      surface: "TASK_FORM",
    });
    sendSuccess(res, {}, "Recorded");
  }),
);
