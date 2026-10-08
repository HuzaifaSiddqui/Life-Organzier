import { Router } from "express";
import { z } from "zod";
import { handle, parseBody, requireUser } from "../../lib/http.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendSuccess } from "../../utils/apiResponse.js";
import { CHECKIN_RESPONSES, respondToCheckin } from "./checkinService.js";

export const checkinRouter = Router();
checkinRouter.use(requireFirebaseUser, requireUser);

/** FR-RN-004: answer a start/completion check-in. Returns the next check-in for the phone to schedule. */
checkinRouter.post(
  "/:id/respond",
  handle(async (req, res) => {
    // respondedAt: when the user tapped (the offline queue may deliver later); clamped to [fireAt, now].
    const body = parseBody(z.object({ response: z.enum(CHECKIN_RESPONSES), respondedAt: z.string().datetime().optional() }), req.body);
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      res.status(404).json({ success: false, message: "Check-in not found", error: "CHECKIN_NOT_FOUND" });
      return;
    }
    const result = await respondToCheckin(req.user.id, req.settings, { userId: req.user.id, tz: req.settings.timezone, deviceId: req.deviceId }, id.data, body.response, new Date(), body.respondedAt ? new Date(body.respondedAt) : null);
    sendSuccess(res, result);
  }),
);
