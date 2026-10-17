import express, { Router, type Request, type Response } from "express";
import { handle, HttpError, requireUser } from "../../lib/http.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendSuccess } from "../../utils/apiResponse.js";
import { EMPTY_TWIML, enqueue, processInbound, recordInbound, twilioSignatureValid } from "./inbound.js";
import { startLink, unlink } from "./linking.js";

/**
 * Twilio WhatsApp webhook (FR-WA-001) and the app's link endpoints. Messages go through the same
 * assistant engine as the app (see inbound.ts); WhatsApp is Pro-only.
 */
export const whatsappRouter = Router();

function validSignature(req: Request): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN;
  // Unsigned requests would let anyone message as any user by faking "From"; only allowed on explicit opt-in.
  if (!token) return process.env.WHATSAPP_ALLOW_UNSIGNED === "true";
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) return false;
  return twilioSignatureValid(`${base.replace(/\/$/, "")}${req.originalUrl}`, req.body as Record<string, string>, req.header("x-twilio-signature"), token);
}

whatsappRouter.post("/webhook", express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  res.type("text/xml");
  if (!validSignature(req)) {
    res.status(403).send(EMPTY_TWIML);
    return;
  }
  const b = req.body as Record<string, string | undefined>;
  const sid = String(b.MessageSid ?? "");
  const from = String(b.From ?? "");
  if (!sid || !from) {
    res.send(EMPTY_TWIML);
    return;
  }
  let fresh: boolean;
  try {
    fresh = await recordInbound(sid, from);
  } catch (error) {
    console.error("WhatsApp webhook could not record the message", error);
    res.status(500).send(EMPTY_TWIML); // Twilio retries; the retry is recorded then
    return;
  }
  res.send(EMPTY_TWIML); // answer now; the reply goes out through the REST API
  if (!fresh) return; // a Twilio retry of a message already handled
  void enqueue(from, () =>
    processInbound({ sid, from, body: String(b.Body ?? ""), numMedia: Number(b.NumMedia ?? 0), mediaType: String(b.MediaContentType0 ?? ""), mediaUrl: String(b.MediaUrl0 ?? "") }),
  );
});

/** New 8-character link code (replaces any earlier one) and the number to send it to. Pro only. */
whatsappRouter.post(
  "/link/start",
  requireFirebaseUser,
  requireUser,
  handle(async (req, res) => {
    if (req.settings.tier !== "PRO") throw new HttpError(403, "PRO_REQUIRED", "WhatsApp is part of Pro");
    const { code, expiresAt } = await startLink(req.user.id);
    sendSuccess(res, { code, expiresAt: expiresAt.toISOString(), botNumber: process.env.TWILIO_WHATSAPP_FROM ?? null });
  }),
);

whatsappRouter.delete(
  "/link",
  requireFirebaseUser,
  requireUser,
  handle(async (req, res) => {
    await unlink(req.user.id);
    sendSuccess(res, {}, "WhatsApp unlinked");
  }),
);
