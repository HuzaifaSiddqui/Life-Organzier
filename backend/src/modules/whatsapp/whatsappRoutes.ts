import crypto from "node:crypto";
import express, { Router, type Request, type Response } from "express";
import { ConversationRole } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { ensureSettings } from "../../lib/http.js";
import { logEvent } from "../events/eventService.js";
import { handleAssistantMessage } from "../assistant/dialogue.js";
import type { ActionPayload, QuickAction } from "../assistant/types.js";
import { processDocumentForWhatsapp } from "./whatsappService.js";

/**
 * Twilio WhatsApp webhook (FR-WA-001). Messages go through the same assistant engine as the app,
 * so memory and context are shared across channels; the conversation window is 24 hours.
 */
export const whatsappRouter = Router();
whatsappRouter.use(express.urlencoded({ extended: false }));

function twiml(message: string): string {
  const escaped = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
}

function validSignature(req: Request): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN;
  // Unsigned requests would let anyone message as any user by faking "From" — only allow them on explicit opt-in.
  if (!token) return process.env.WHATSAPP_ALLOW_UNSIGNED === "true";
  const signature = req.header("x-twilio-signature");
  const base = process.env.PUBLIC_BASE_URL;
  if (!signature || !base) return false;
  const url = `${base.replace(/\/$/, "")}${req.originalUrl}`;
  const params = req.body as Record<string, string>;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = crypto.createHmac("sha1", token).update(Buffer.from(data, "utf-8")).digest("base64");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature.padEnd(expected.length).slice(0, expected.length)));
}

async function lastActions(userId: string): Promise<QuickAction[]> {
  const last = await prisma.conversationMessage.findFirst({
    where: { userId, role: ConversationRole.ASSISTANT, conversation: { channel: "WHATSAPP" } },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  const meta = last?.metadata as { actions?: QuickAction[] } | null;
  return Array.isArray(meta?.actions) ? meta.actions : [];
}

function formatReply(content: string, actions: QuickAction[]): string {
  const usable = actions.filter((a) => !(a.payload && ["open_task", "navigate", "breathing"].includes(a.payload.type))).slice(0, 5);
  if (!usable.length) return content;
  return `${content}\n\n${usable.map((a, i) => `${i + 1}. ${a.label}`).join("\n")}`;
}

whatsappRouter.post("/webhook", async (req: Request, res: Response) => {
  res.type("text/xml");
  try {
    if (!validSignature(req)) {
      res.status(403).send(twiml("Invalid signature"));
      return;
    }
    const from = String(req.body.From ?? "").replace(/^whatsapp:/, "").trim();
    const body = String(req.body.Body ?? "").trim();
    const user = from ? await prisma.user.findUnique({ where: { phoneNumber: from } }) : null;
    if (!user) {
      res.send(twiml("Hi! This number isn't linked to a Life Organizer account yet. Open the app → Settings → WhatsApp and add this number."));
      return;
    }
    const settings = await prisma.userSettings.update({
      where: { userId: (await ensureSettings(user.id)).userId },
      data: { lastWhatsappMessageAt: new Date() },
    });
    logEvent(user.id, "WHATSAPP_RECEIVED", null, { hasMedia: Number(req.body.NumMedia ?? 0) > 0 });

    const mediaType = String(req.body.MediaContentType0 ?? "");
    if (Number(req.body.NumMedia ?? 0) > 0) {
      if (mediaType.startsWith("audio/")) {
        res.send(twiml("Voice notes aren't supported on WhatsApp yet — please type your message, or use voice in the app."));
        return;
      }
      if (mediaType.startsWith("image/") || mediaType === "application/pdf") {
        const summary = await processDocumentForWhatsapp(user, settings, String(req.body.MediaUrl0), mediaType);
        res.send(twiml(summary));
        return;
      }
    }
    if (!body) {
      res.send(twiml("Send me a message like \"Add assignment due Friday 3 PM\" or \"What do I have today?\""));
      return;
    }

    // Numbered or exact-label replies map to the previous message's quick actions.
    const actions = await lastActions(user.id);
    const n = /^\d$/.test(body) ? Number(body) : NaN;
    const picked = Number.isInteger(n) && n >= 1 && n <= actions.length ? actions[n - 1] : actions.find((a) => a.label.toLowerCase() === body.toLowerCase());
    const reply = await handleAssistantMessage({
      user,
      settings,
      deviceId: "whatsapp",
      text: picked?.payload ? null : (picked?.text ?? body),
      payload: (picked?.payload as ActionPayload | undefined) ?? null,
      label: picked?.label ?? null,
      channel: "WHATSAPP",
    });
    res.send(twiml(formatReply(reply.message.content, reply.message.actions ?? [])));
  } catch (error) {
    console.error("WhatsApp webhook failed", error);
    res.send(twiml("Sorry, something went wrong. Please try again."));
  }
});
