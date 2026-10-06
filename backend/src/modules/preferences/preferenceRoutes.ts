import { Router } from "express";
import { z } from "zod";
import { handle, parseBody, requireUser } from "../../lib/http.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendSuccess } from "../../utils/apiResponse.js";
import { rememberFact } from "../memory/memoryService.js";

/** Legacy endpoint kept for compatibility: free-text preferences are now long-term memories. */
export const preferenceRouter = Router();
preferenceRouter.use(requireFirebaseUser, requireUser);

preferenceRouter.post(
  "/",
  handle(async (req, res) => {
    const { content } = parseBody(z.object({ content: z.string().trim().min(1).max(2000) }), req.body);
    const { memory } = await rememberFact(req.user.id, {
      kind: "PREFERENCE",
      content: /^user\b/i.test(content) ? content : `User preference: ${content}`,
      importance: 0.8,
      source: "preference",
    });
    const { embedding: _e, ...rest } = memory;
    sendSuccess(res, { preference: rest }, "Preference saved", 201);
  }),
);
