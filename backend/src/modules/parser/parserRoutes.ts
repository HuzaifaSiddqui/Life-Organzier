import { Router } from "express";
import { z } from "zod";
import type { AuthRequest } from "../../middleware/authMiddleware.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendError, sendSuccess } from "../../utils/apiResponse.js";
import { parseTaskFromTextHybrid } from "./taskParserService.js";

export const parserRouter = Router();

const ymdRegex = /^\d{4}-\d{2}-\d{2}$/;
const bodySchema = z.object({
  text: z.string().min(1),
  /** Device-local "today" as YYYY-MM-DD so relative phrases match the user's calendar (not the server's TZ). */
  clientTodayYmd: z.string().regex(ymdRegex).optional(),
  clientNowIso: z.string().min(20).optional(),
  clientTimezoneOffsetMinutes: z.number().int().gte(-840).lte(840).optional(),
});

parserRouter.post("/task", requireFirebaseUser, async (req: AuthRequest, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Text is required", "VALIDATION_ERROR", 400);
    return;
  }

  try {
    const { text, clientTodayYmd, clientNowIso, clientTimezoneOffsetMinutes } = parsed.data;
    const data = await parseTaskFromTextHybrid(text, {
      clientTodayYmd,
      clientNowIso,
      clientTimezoneOffsetMinutes,
    });
    sendSuccess(res, data);
  } catch (e) {
    console.error(e);
    sendError(res, "Could not parse task", "PARSER_FAILED", 500);
  }
});
