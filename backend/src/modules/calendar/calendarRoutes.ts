import { Router } from "express";
import { handle, requireUser } from "../../lib/http.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendSuccess } from "../../utils/apiResponse.js";
import { calendarFeed, calendarSyncOn } from "./calendarService.js";

export const calendarRouter = Router();
calendarRouter.use(requireFirebaseUser, requireUser);

/** CALENDAR_SYNC: routine occurrences for the phone's calendar. Off: `{ enabled: false }` and the phone does nothing. */
calendarRouter.get(
  "/feed",
  handle(async (req, res) => {
    if (!calendarSyncOn()) return sendSuccess(res, { enabled: false });
    sendSuccess(res, { enabled: true, ...(await calendarFeed(req.user.id, req.settings.timezone)) });
  }),
);
