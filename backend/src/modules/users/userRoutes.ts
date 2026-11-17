import { Router } from "express";
import { z } from "zod";
import { handle, parseBody, requireUser } from "../../lib/http.js";
import { removePhoto, setPhoto } from "./photoService.js";
import { maskNumber } from "../whatsapp/linking.js";
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
    sendSuccess(res, { user: user && { ...user, phoneNumber: maskNumber(user.phoneNumber) } });
  } catch (e) {
    console.error(e);
    sendError(res, "Could not load profile", "PROFILE_FAILED", 500);
  }
});

/** The user's own profile photo (base64 image; the app sends a 512 px square crop). */
userRouter.put(
  "/me/photo",
  requireFirebaseUser,
  requireUser,
  handle(async (req, res) => {
    const body = parseBody(z.object({ image: z.string().min(1).max(2_100_000) }), req.body);
    const user = await setPhoto(req.user.id, body.image);
    sendSuccess(res, { user: { ...user, phoneNumber: maskNumber(user.phoneNumber) } }, "Photo updated");
  }),
);

/** Removes the profile photo (the Google one is not brought back). */
userRouter.delete(
  "/me/photo",
  requireFirebaseUser,
  requireUser,
  handle(async (req, res) => {
    const user = await removePhoto(req.user.id);
    sendSuccess(res, { user: { ...user, phoneNumber: maskNumber(user.phoneNumber) } }, "Photo removed");
  }),
);
