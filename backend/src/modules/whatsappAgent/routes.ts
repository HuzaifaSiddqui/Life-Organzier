import { Router, type NextFunction, type Response } from "express";
import { z } from "zod";
import { setBounded } from "../../lib/boundedMap.js";
import { handle, parseBody, requireUser, type UserRequest } from "../../lib/http.js";
import { requireFirebaseUser, type AuthRequest } from "../../middleware/authMiddleware.js";
import { sendError, sendSuccess } from "../../utils/apiResponse.js";
import { agentStatus, connectAgent, disconnectAgent, requireAgentFeature, sendTestMessage, updateAgentSettings } from "./service.js";

/**
 * /api/whatsapp-agent (WHATSAPP_AGENT=on). Every route needs a signed-in user and acts only on that user's own
 * connection. Connect and test messages are rate-limited per user. The API key is accepted once and never
 * returned: responses show only its last 4 characters.
 */
export const whatsappAgentRouter = Router();
whatsappAgentRouter.use(requireFirebaseUser, requireUser);

// ponytail: in-memory per server process, like the Twilio notice throttle; enough for one instance.
const hits = new Map<string, number[]>();

/** At most `max` calls per `windowMs` per user for this route. */
export function perUserLimit(name: string, max: number, windowMs: number) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    const user = (req as UserRequest).user?.id ?? "anon";
    const key = `${name}:${user}`;
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      sendError(res, "Too many attempts. Please wait a minute and try again.", "RATE_LIMITED", 429);
      return;
    }
    setBounded(hits, key, [...recent, now], 10000);
    next();
  };
}

/** Test hook. */
export function resetRouteLimits(): void {
  hits.clear();
}

whatsappAgentRouter.get(
  "/status",
  handle(async (req, res) => {
    sendSuccess(res, await agentStatus(req.user.id));
  }),
);

whatsappAgentRouter.post(
  "/connect",
  perUserLimit("connect", 5, 10 * 60000),
  handle(async (req, res) => {
    requireAgentFeature();
    const body = parseBody(z.object({ apiKey: z.string().trim().min(8).max(512), consent: z.literal(true, { errorMap: () => ({ message: "Please agree to the privacy notice first" }) }) }), req.body);
    sendSuccess(res, await connectAgent(req.user.id, body.apiKey), "WhatsApp connected");
  }),
);

whatsappAgentRouter.post(
  "/test",
  perUserLimit("test", 3, 60000),
  handle(async (req, res) => {
    await sendTestMessage(req.user.id, req.settings.language);
    sendSuccess(res, {}, "Test message sent");
  }),
);

whatsappAgentRouter.patch(
  "/settings",
  perUserLimit("settings", 20, 60000),
  handle(async (req, res) => {
    const body = parseBody(z.object({ reminders: z.enum(["OFF", "WHATSAPP", "BOTH"]).optional(), voice: z.boolean().optional() }), req.body);
    sendSuccess(res, await updateAgentSettings(req.user.id, body));
  }),
);

whatsappAgentRouter.delete(
  "/",
  handle(async (req, res) => {
    await disconnectAgent(req.user.id);
    sendSuccess(res, {}, "WhatsApp disconnected");
  }),
);
