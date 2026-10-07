import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db.js";
import { handle, parseBody, requireUser } from "../../lib/http.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendSuccess } from "../../utils/apiResponse.js";
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
