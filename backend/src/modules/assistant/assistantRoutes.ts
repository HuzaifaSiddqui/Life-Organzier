import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db.js";
import { getAi } from "../../ai/llm.js";
import { handle, parseBody, requireUser } from "../../lib/http.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendSuccess } from "../../utils/apiResponse.js";
import { getOrCreateConversation, listConversations, listMessages, startNewConversation } from "../conversations/conversationService.js";
import { getAttention, getBriefing } from "./briefing.js";
import { handleAssistantMessage } from "./dialogue.js";
import type { ActionPayload } from "./types.js";

export const assistantRouter = Router();
assistantRouter.use(requireFirebaseUser, requireUser);

const payloadSchema = z.object({ type: z.string().min(1).max(40) }).passthrough();

const messageSchema = z
  .object({
    text: z.string().trim().max(4000).optional().nullable(),
    payload: payloadSchema.optional().nullable(),
    label: z.string().max(200).optional().nullable(),
    conversationId: z.string().uuid().optional().nullable(),
    channel: z.enum(["APP", "VOICE"]).optional(),
  })
  .refine((v) => Boolean(v.text?.trim()) || Boolean(v.payload), "text or payload is required");

assistantRouter.post(
  "/message",
  handle(async (req, res) => {
    const body = parseBody(messageSchema, req.body);
    const reply = await handleAssistantMessage({
      user: req.user,
      settings: req.settings,
      deviceId: req.deviceId,
      text: body.text ?? null,
      payload: (body.payload as ActionPayload | undefined) ?? null,
      label: body.label ?? null,
      conversationId: body.conversationId ?? null,
      channel: body.channel ?? "APP",
    });
    sendSuccess(res, reply);
  }),
);

assistantRouter.get(
  "/conversations",
  handle(async (req, res) => {
    sendSuccess(res, { conversations: await listConversations(req.user.id) });
  }),
);

assistantRouter.get(
  "/conversations/current",
  handle(async (req, res) => {
    const channel = req.query.channel === "VOICE" ? "VOICE" : "APP";
    const conversation = await getOrCreateConversation(req.user.id, channel);
    const messages = await listMessages(req.user.id, conversation.id);
    sendSuccess(res, { conversation: { id: conversation.id, title: conversation.title, summary: conversation.summary }, messages });
  }),
);

assistantRouter.post(
  "/conversations/new",
  handle(async (req, res) => {
    const conversation = await startNewConversation(req.user.id, "APP");
    sendSuccess(res, { conversation: { id: conversation.id, title: null, summary: null }, messages: [] }, "New conversation", 201);
  }),
);

assistantRouter.get(
  "/conversations/:id/messages",
  handle(async (req, res) => {
    const before = typeof req.query.before === "string" && !Number.isNaN(Date.parse(req.query.before)) ? new Date(req.query.before) : undefined;
    const conversation = await prisma.conversation.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!conversation) {
      sendSuccess(res, { messages: [] });
      return;
    }
    sendSuccess(res, { messages: await listMessages(req.user.id, conversation.id, before) });
  }),
);

assistantRouter.get(
  "/briefing",
  handle(async (req, res) => {
    sendSuccess(res, { briefing: await getBriefing(req.user, req.settings), ai: { enabled: getAi().enabled, available: getAi().available } });
  }),
);

assistantRouter.get(
  "/attention",
  handle(async (req, res) => {
    sendSuccess(res, { attention: await getAttention(req.user, req.settings) });
  }),
);
