import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db.js";
import { removeUserFiles } from "../../lib/storage.js";
import { handle, HttpError, parseBody, requireUser } from "../../lib/http.js";
import { getFirebaseAuth } from "../../config/firebase.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendSuccess } from "../../utils/apiResponse.js";
import { exportFile, exportFormat } from "../analytics/analyticsService.js";

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

/** Full data export (FR-AP-001 §3): tasks, routines and mood logs as CSV or Excel (`?format=xlsx`). */
accountRouter.get(
  "/export",
  handle(async (req, res) => {
    sendSuccess(res, await exportFile(req.user.id, exportFormat(req.query.format), "life-organizer-data", req.settings.timezone));
  }),
);

/**
 * Guest mode (FR-OB-003): a guest who chooses "Start fresh" when creating an account, or signs out, loses their
 * guest data at once (there is no account to recover it with). The Firebase guest account goes too. Accounts can't
 * use this: they have the 30-day deletion below.
 */
accountRouter.post(
  "/guest/discard",
  handle(async (req, res) => {
    if (!req.user.isGuest) throw new HttpError(403, "NOT_GUEST", "Only a guest account can be discarded this way.");
    await prisma.user.delete({ where: { id: req.user.id } });
    await removeUserFiles(req.user.id).catch((error: unknown) => console.warn("Could not delete user files", error));
    await getFirebaseAuth()
      .deleteUser(req.user.firebaseUid)
      .catch((error: unknown) => console.warn("Could not delete Firebase guest", error instanceof Error ? error.message : error));
    sendSuccess(res, {}, "Guest data deleted");
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
