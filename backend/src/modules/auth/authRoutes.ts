import { Router } from "express";
import type { AuthRequest } from "../../middleware/authMiddleware.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendError, sendSuccess } from "../../utils/apiResponse.js";
import { syncUserFromFirebase } from "../users/userService.js";

export const authRouter = Router();

authRouter.post("/sync-user", requireFirebaseUser, async (req: AuthRequest, res) => {
  try {
    const fb = req.firebase;
    if (!fb?.uid || !fb.email) {
      sendError(res, "Token is missing email claim", "INVALID_TOKEN", 400);
      return;
    }

    const user = await syncUserFromFirebase({
      firebaseUid: fb.uid,
      email: fb.email,
      displayName: fb.name ?? null,
      photoUrl: fb.picture ?? null,
    });

    sendSuccess(res, { user }, "User synced");
  } catch (e) {
    console.error(e);
    sendError(res, "Could not sync user", "SYNC_FAILED", 500);
  }
});
