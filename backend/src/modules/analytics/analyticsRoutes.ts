import { Router } from "express";
import { handle, HttpError, requireUser } from "../../lib/http.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendSuccess } from "../../utils/apiResponse.js";
import { exportFile, exportFormat, getAnalytics, type RangeKey } from "./analyticsService.js";

export const analyticsRouter = Router();
analyticsRouter.use(requireFirebaseUser, requireUser);

const RANGES: RangeKey[] = ["week", "month", "3months", "all"];

analyticsRouter.get(
  "/",
  handle(async (req, res) => {
    const range = RANGES.includes(req.query.range as RangeKey) ? (req.query.range as RangeKey) : "month";
    sendSuccess(res, { analytics: await getAnalytics(req.user.id, req.settings.timezone, range) });
  }),
);

/** Export of analytics data as CSV or Excel (`?format=xlsx`) (Pro tier, FR-AN-002 §5). */
analyticsRouter.get(
  "/export",
  handle(async (req, res) => {
    if (req.settings.tier !== "PRO") throw new HttpError(403, "PRO_REQUIRED", "Analytics export is a Pro feature");
    sendSuccess(res, await exportFile(req.user.id, exportFormat(req.query.format), "life-organizer", req.settings.timezone));
  }),
);
