import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db.js";
import { handle, parseBody, requireUser } from "../../lib/http.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendSuccess } from "../../utils/apiResponse.js";
import { exportCsv } from "../analytics/analyticsService.js";

export const accountRouter = Router();
accountRouter.use(requireFirebaseUser, requireUser);

accountRouter.get(
  "/",
  handle(async (req, res) => {
    sendSuccess(res, {
      user: req.user,
      tier: req.settings.tier,
      deletion: req.user.deletionRequestedAt
        ? { requestedAt: req.user.deletionRequestedAt, permanentAt: new Date(req.user.deletionRequestedAt.getTime() + 30 * 86400000) }
        : null,
    });
  }),
);

accountRouter.put(
  "/profile",
  handle(async (req, res) => {
    const body = parseBody(z.object({ displayName: z.string().trim().min(1).max(80) }), req.body);
    const user = await prisma.user.update({ where: { id: req.user.id }, data: { displayName: body.displayName } });
    sendSuccess(res, { user }, "Profile updated");
  }),
);

/** Full data export (FR-AP-001 §3): tasks, routines and mood logs as CSV. */
accountRouter.get(
  "/export",
  handle(async (req, res) => {
    sendSuccess(res, { filename: `life-organizer-data-${new Date().toISOString().slice(0, 10)}.csv`, csv: await exportCsv(req.user.id) });
  }),
);

/** Account deletion with a 30-day recovery window (FR-AP-001 §4). */
accountRouter.post(
  "/delete",
  handle(async (req, res) => {
    const user = await prisma.user.update({ where: { id: req.user.id }, data: { deletionRequestedAt: new Date() } });
    sendSuccess(
      res,
      { permanentAt: new Date((user.deletionRequestedAt as Date).getTime() + 30 * 86400000) },
      "Your account will be permanently deleted in 30 days. Sign in any time before then to recover it.",
    );
  }),
);

accountRouter.post(
  "/recover",
  handle(async (req, res) => {
    await prisma.user.update({ where: { id: req.user.id }, data: { deletionRequestedAt: null } });
    sendSuccess(res, {}, "Account recovered — welcome back!");
  }),
);
