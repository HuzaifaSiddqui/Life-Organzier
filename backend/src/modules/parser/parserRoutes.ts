import { Router } from "express";
import { z } from "zod";
import type { AuthRequest } from "../../middleware/authMiddleware.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendError, sendSuccess } from "../../utils/apiResponse.js";
import { parseTaskFromText } from "./taskParserService.js";

export const parserRouter = Router();

const bodySchema = z.object({
  text: z.string().min(1),
});

parserRouter.post("/task", requireFirebaseUser, (req: AuthRequest, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Text is required", "VALIDATION_ERROR", 400);
    return;
  }

  try {
    const data = parseTaskFromText(parsed.data.text);
    sendSuccess(res, data);
  } catch (e) {
    console.error(e);
    sendError(res, "Could not parse task", "PARSER_FAILED", 500);
  }
});
