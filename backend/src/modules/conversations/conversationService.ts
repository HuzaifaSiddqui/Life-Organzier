import { ConversationRole, Prisma, type Conversation, type ConversationMessage } from "@prisma/client";
import { prisma } from "../../config/db.js";
import type { ChatMessage } from "../../ai/llm.js";
import { emptyState, type DialogueState } from "../assistant/types.js";

/** Messages within this window continue the same conversation (FR-WA-001 §3 uses 24h for WhatsApp). */
const CONTINUE_WINDOW_HOURS: Record<string, number> = { APP: 12, VOICE: 12, WHATSAPP: 24 };

export async function getOrCreateConversation(userId: string, channel: string, conversationId?: string | null): Promise<Conversation> {
  if (conversationId) {
    const existing = await prisma.conversation.findFirst({ where: { id: conversationId, userId } });
    if (existing) return existing;
  }
  const windowHours = CONTINUE_WINDOW_HOURS[channel] ?? 12;
  const recent = await prisma.conversation.findFirst({
    where: { userId, channel, lastMessageAt: { gte: new Date(Date.now() - windowHours * 3600000) } },
    orderBy: { lastMessageAt: "desc" },
  });
  if (recent) return recent;
  return prisma.conversation.create({ data: { userId, channel } });
}

export async function startNewConversation(userId: string, channel: string): Promise<Conversation> {
  return prisma.conversation.create({ data: { userId, channel } });
}

export function readState(conversation: Conversation): DialogueState {
  const raw = conversation.state;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyState();
  const s = raw as Record<string, unknown>;
  return {
    pending: (s.pending as DialogueState["pending"]) ?? null,
    focus: Array.isArray(s.focus) ? (s.focus as string[]).slice(0, 8) : [],
    prereqAsked: Array.isArray(s.prereqAsked) ? (s.prereqAsked as string[]) : [],
    turn: typeof s.turn === "number" ? s.turn : 0,
  };
}

export async function saveState(conversationId: string, state: DialogueState): Promise<void> {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { state: state as unknown as Prisma.InputJsonValue, lastMessageAt: new Date() },
  });
}

export async function addMessage(input: {
  conversationId: string;
  userId: string;
  role: ConversationRole;
  content: string;
  metadata?: Prisma.InputJsonValue | null;
  embedding?: Prisma.InputJsonValue | null;
}): Promise<ConversationMessage> {
  return prisma.conversationMessage.create({
    data: {
      conversationId: input.conversationId,
      userId: input.userId,
      role: input.role,
      content: input.content,
      metadata: input.metadata ?? Prisma.JsonNull,
      embedding: input.embedding ?? Prisma.JsonNull,
    },
  });
}

export async function recentChat(conversationId: string, limit = 8): Promise<ChatMessage[]> {
  const messages = await prisma.conversationMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { role: true, content: true },
  });
  return messages
    .reverse()
    .filter((m) => m.role !== ConversationRole.SYSTEM)
    .map((m) => ({ role: m.role === ConversationRole.USER ? "user" : "assistant", content: m.content }));
}

export async function listMessages(userId: string, conversationId: string, before?: Date, limit = 40) {
  const messages = await prisma.conversationMessage.findMany({
    where: { userId, conversationId, ...(before ? { createdAt: { lt: before } } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, role: true, content: true, metadata: true, createdAt: true },
  });
  return messages.reverse();
}

export async function listConversations(userId: string) {
  return prisma.conversation.findMany({
    where: { userId },
    orderBy: { lastMessageAt: "desc" },
    take: 30,
    select: { id: true, title: true, channel: true, summary: true, lastMessageAt: true, createdAt: true },
  });
}
