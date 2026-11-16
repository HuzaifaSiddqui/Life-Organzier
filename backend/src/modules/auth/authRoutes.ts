import { Router } from "express";
import { maskNumber } from "../whatsapp/linking.js";
import type { AuthRequest } from "../../middleware/authMiddleware.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendError, sendSuccess } from "../../utils/apiResponse.js";
import { syncUserFromFirebase } from "../users/userService.js";
import { guestModeOn, syncDecision } from "../guest/guestRules.js";

export const authRouter = Router();

authRouter.post("/sync-user", requireFirebaseUser, async (req: AuthRequest, res) => {
  try {
    const fb = req.firebase;
    const decision = fb?.uid ? syncDecision({ uid: fb.uid, email: fb.email, provider: fb.provider }, guestModeOn()) : "no_email";
    if (!fb || decision === "no_email") {
      sendError(res, "Token is missing email claim", "INVALID_TOKEN", 400);
      return;
    }
    if (decision === "guest_mode_off") {
      sendError(res, "Guest mode is off on this server. Create an account to continue.", "GUEST_MODE_OFF", 403);
      return;
    }

    // A guest who converted (same Firebase account, now with an email) becomes a normal account here; data stays.
    const user = await syncUserFromFirebase({
      firebaseUid: fb.uid,
      email: decision === "account" ? (fb.email ?? null) : null,
      isGuest: decision === "guest",
      displayName: fb.name ?? null,
      photoUrl: fb.picture ?? null,
    });

    sendSuccess(res, { user: { ...user, phoneNumber: maskNumber(user.phoneNumber) } }, "User synced");
  } catch (e) {
    console.error(e);
    sendError(res, "Could not sync user", "SYNC_FAILED", 500);
  }
});
