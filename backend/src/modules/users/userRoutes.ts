import { Router } from "express";
import type { AuthRequest } from "../../middleware/authMiddleware.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendError, sendSuccess } from "../../utils/apiResponse.js";
import { getUserByFirebaseUid } from "./userService.js";

export const userRouter = Router();

userRouter.get("/me", requireFirebaseUser, async (req: AuthRequest, res) => {
  try {
    const uid = req.firebase?.uid;
    if (!uid) {
      sendError(res, "Unauthorized", "UNAUTHORIZED", 401);
      return;
    }
    const user = await getUserByFirebaseUid(uid);
    if (!user) {
      sendError(res, "User not found. Call sync-user first.", "USER_NOT_FOUND", 404);
      return;
    }
    sendSuccess(res, { user });
  } catch (e) {
    console.error(e);
    sendError(res, "Could not load profile", "PROFILE_FAILED", 500);
  }
});
