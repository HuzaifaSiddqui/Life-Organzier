import { Router } from "express";
import { z } from "zod";
import { handle, parseBody, requireUser } from "../../lib/http.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendSuccess } from "../../utils/apiResponse.js";
import { registerPushToken, unregisterDeviceToken, unregisterPushToken } from "./pushService.js";

/** Expo push tokens of the signed-in user's devices (P2). */
export const pushRouter = Router();

const token = z.string().trim().min(10).max(300).regex(/^(?:Expo(?:nent)?PushToken\[[^\]]+\]|[\w:-]+)$/, "Not a push token");

/**
 * No login: used by the phone's sign-out retry queue, which may run after the user signed out. Proof is
 * the token plus the device's random install id; it can only stop pushes to that device. Always 200.
 */
pushRouter.post(
  "/unregister-device",
  handle(async (req, res) => {
    const body = parseBody(z.object({ token, deviceId: z.string().trim().min(8).max(100) }), req.body);
    await unregisterDeviceToken(body.token, body.deviceId);
    sendSuccess(res, {}, "Push unregistered");
  }),
);

pushRouter.use(requireFirebaseUser, requireUser);

pushRouter.post(
  "/register",
  handle(async (req, res) => {
    const body = parseBody(z.object({ token, platform: z.enum(["android", "ios"]), deviceId: z.string().max(100).nullish() }), req.body);
    await registerPushToken(req.user.id, body);
    sendSuccess(res, {}, "Push registered");
  }),
);

pushRouter.delete(
  "/register",
  handle(async (req, res) => {
    const body = parseBody(z.object({ token }), req.body);
    await unregisterPushToken(req.user.id, body.token);
    sendSuccess(res, {}, "Push unregistered");
  }),
);
