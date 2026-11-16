import { ConversationRole, type Prisma } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { addMessage, getOrCreateConversation } from "../conversations/conversationService.js";

/**
 * Documents sent in the assistant chat (the app's "+" in the message box). The upload itself is the normal
 * POST /documents; with `conversationId` the server also writes the exchange into that chat, so it stays in the
 * history like any other message: the user's "file + request" and the assistant's summary with a `document` card
 * (counts and a Review button that opens the usual review). The summary is fixed text, no model.
 */

export type DocumentChatCard = {
  type: "document";
  documentId: string;
  fileName: string;
  deadlines: number;
  schedules: number;
  /** Added at once (the rules were sure), as on the Documents screen. */
  added: number;
  /** Found but not added: waiting for the user's review. */
  toReview: number;
  warning: string | null;
  reused: boolean;
};

type Item = { created?: boolean; existing?: boolean; filteredOut?: boolean };
export type ChatResultLike = {
  reused?: boolean;
  document: { id: string; fileName: string };
  extracted: { deadlines: Item[]; schedules: Item[]; warning: string | null };
  createdTasks: unknown[];
  createdRoutines: unknown[];
};

export function documentCard(r: ChatResultLike): DocumentChatCard {
  const shown = (items: Item[]) => items.filter((i) => !i.filteredOut);
  const deadlines = shown(r.extracted.deadlines);
  const schedules = shown(r.extracted.schedules);
  const toReview = [...deadlines, ...schedules].filter((i) => !i.created && !i.existing).length;
  return {
    type: "document",
    documentId: r.document.id,
    fileName: r.document.fileName,
    deadlines: deadlines.length,
    schedules: schedules.length,
    added: r.createdTasks.length + r.createdRoutines.length,
    toReview,
    warning: r.extracted.warning,
    reused: Boolean(r.reused),
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The assistant's reply under an uploaded document (English or Urdu, the user's language). */
export function documentChatSummary(card: DocumentChatCard, language: string): string {
  const ur = language === "ur";
  if (card.reused) return ur ? `یہ فائل آپ پہلے بھیج چکے ہیں، اس لیے یہ وہی ہے جو تب ملا تھا۔ کچھ دوبارہ شامل نہیں کیا۔` : `You sent ${card.fileName} before, so here's what I found then. Nothing was added twice.`;
  if (!card.deadlines && !card.schedules) {
    return ur ? `میں نے ${card.fileName} پڑھی لیکن اس میں کوئی تاریخ یا کلاس کا وقت نہیں ملا۔` : `I read ${card.fileName} but didn't find any dates or class times in it.`;
  }
  if (ur) {
    const found = [card.deadlines ? `${card.deadlines} ڈیڈ لائن` : null, card.schedules ? `${card.schedules} کلاسیں` : null].filter(Boolean).join(" اور ");
    const added = card.added ? ` جن پر مجھے یقین تھا وہ ${card.added} شامل کر دیں۔` : "";
    const review = card.toReview ? ` ${card.toReview} آپ کے دیکھنے کے لیے رکھی ہیں۔` : "";
    return `میں نے ${card.fileName} پڑھی: ${found} ملیں۔${added}${review}`;
  }
  const found = [card.deadlines ? plural(card.deadlines, "deadline", "deadlines") : null, card.schedules ? plural(card.schedules, "class", "classes") : null].filter(Boolean).join(" and ");
  const added = card.added ? ` I added the ${card.added === 1 ? "one" : card.added} I was sure about.` : "";
  const review = card.toReview ? ` ${plural(card.toReview, "item is", "items are")} waiting for your review.` : "";
  return `I read ${card.fileName} and found ${found}.${added}${review}`;
}

/**
 * Writes "file + request" and the summary into the user's app chat. Returns the conversation and the two messages
 * in the shape the chat screen lists them.
 */
export async function recordUploadInChat(
  userId: string,
  language: string,
  conversationId: string | null,
  result: ChatResultLike,
  request: string | null,
) {
  const conversation = await getOrCreateConversation(userId, "APP", conversationId);
  const card = documentCard(result);
  const userText = request?.trim() ? request.trim() : result.document.fileName;
  const userMessage = await addMessage({
    conversationId: conversation.id,
    userId,
    role: ConversationRole.USER,
    content: userText,
    metadata: { attachment: { documentId: result.document.id, fileName: result.document.fileName } } as Prisma.InputJsonValue,
  });
  const assistantMessage = await addMessage({
    conversationId: conversation.id,
    userId,
    role: ConversationRole.ASSISTANT,
    content: documentChatSummary(card, language),
    metadata: { intent: "document", cards: [card] } as unknown as Prisma.InputJsonValue,
  });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
  return { conversationId: conversation.id, messages: [userMessage, assistantMessage] };
}
