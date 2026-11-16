import { ConversationRole, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "../../config/db.js";
import { embedOne, embedTexts } from "../../ai/embeddings.js";
import { getAi } from "../../ai/llm.js";
import { cosineSimilarity, fuzzySimilarity, truncate } from "../../lib/text.js";
import { addMessage } from "../conversations/conversationService.js";
import { isGrounded, relevanceFloor, rememberFact, TRANSIENT } from "../memory/memoryService.js";
import { answerGrounded, chunkText, type Knowledge, type KnowledgeFact } from "./knowledgeRules.js";

/**
 * DOC_KNOWLEDGE: documents teach the assistant about the user (FR-AM memory, CLAUDE.md "the LLM does narrow jobs").
 * After a document is sent in chat, in the background:
 *  1. its masked text is cut into pieces with embeddings (DocumentChunk), so later questions can be answered from it;
 *  2. the model proposes facts about the user from it (JSON, zod); only facts whose words are in the document are
 *     offered, and nothing is saved until the user ticks it (the chat card "Keep selected").
 * Questions in chat that no command took are looked up in those pieces (answerFromDocuments).
 */

const FACT_TEXT_LIMIT = 6000;
const MAX_FACTS = 6;

const factsSchema = z.object({
  facts: z.array(z.object({ type: z.enum(["FACT", "PREFERENCE", "GOAL", "COURSE"]), content: z.string().min(8).max(200) })).max(8),
});
const FACTS_JSON = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      maxItems: 8,
      items: { type: "object", properties: { type: { type: "string", enum: ["FACT", "PREFERENCE", "GOAL", "COURSE"] }, content: { type: "string" } }, required: ["type", "content"] },
    },
  },
  required: ["facts"],
};

const answerSchema = z.object({ found: z.boolean(), answer: z.string().max(400), excerpt: z.number().int().min(1).max(5) });
const ANSWER_JSON = {
  type: "object",
  properties: { found: { type: "boolean" }, answer: { type: "string" }, excerpt: { type: "integer", minimum: 1, maximum: 5 } },
  required: ["found", "answer", "excerpt"],
};

/** Facts about the user proposed from a document: grounded in its text, never one-off items. */
export async function proposeFacts(text: string): Promise<KnowledgeFact[]> {
  const ai = getAi();
  if (!ai.available || text.trim().length < 200) return [];
  const result = await ai.json(
    [
      {
        role: "system",
        content:
          "The user sent this document to their personal assistant. List up to 6 DURABLE facts about the user themself that are stated in it: what and where they study, their degree, job or internship, skills, goals, preferences, and dates in their own life (for example when an internship starts). Write each as one short sentence in third person starting with 'User'. Never list tasks, deadlines, class times or facts about other people. If the document is not about the user (a notice, a timetable, a textbook), return {\"facts\": []}.",
      },
      { role: "user", content: truncate(text, FACT_TEXT_LIMIT) },
    ],
    factsSchema,
    { json: FACTS_JSON, maxTokens: 400, timeoutMs: 90000, background: true },
  );
  const seen = new Set<string>();
  return (result?.facts ?? [])
    .map((f) => ({ kind: f.type, content: f.content.trim() }))
    .filter((f) => /^user\b/i.test(f.content) && !TRANSIENT.test(f.content) && isGrounded(f.content, text))
    .filter((f) => !seen.has(f.content.toLowerCase()) && seen.add(f.content.toLowerCase()))
    .slice(0, MAX_FACTS)
    .map((f) => ({ id: randomUUID().slice(0, 8), ...f }));
}

export type DocumentFactsCard = { type: "document_facts"; documentId: string; fileName: string; facts: KnowledgeFact[]; kept?: string[] };

function factsMessage(fileName: string, count: number, language: string): string {
  return language === "ur"
    ? `مجھے ${fileName} میں آپ کے بارے میں ${count} باتیں ملیں۔ جو یاد رکھنی ہیں ان پر نشان لگائیں۔`
    : `I found ${count} ${count === 1 ? "thing" : "things"} about you in ${fileName}. Tick the ones I should remember.`;
}

/** Background, after a chat upload: pieces for search, then proposed facts as a chat card. Never throws. */
export async function learnFromDocument(userId: string, documentId: string, conversationId: string, language: string): Promise<void> {
  try {
    const doc = await prisma.document.findFirst({ where: { id: documentId, userId } });
    if (!doc) return;
    const previous = doc.knowledge as Knowledge | null;
    if (previous?.status === "done") return; // the same file sent again
    await prisma.document.update({ where: { id: doc.id }, data: { knowledge: { status: "pending", facts: [] } as unknown as Prisma.InputJsonValue } });

    const pieces = chunkText(doc.text);
    if (pieces.length) {
      const { model, vectors } = await embedTexts(pieces, "document");
      await prisma.documentChunk.deleteMany({ where: { documentId: doc.id } });
      await prisma.documentChunk.createMany({ data: pieces.map((text, idx) => ({ documentId: doc.id, userId, idx, text, embedding: vectors[idx] ?? [], embeddingModel: model })) });
    }

    const facts = await proposeFacts(doc.text).catch(() => []);
    let messageId: string | undefined;
    if (facts.length) {
      const card: DocumentFactsCard = { type: "document_facts", documentId: doc.id, fileName: doc.fileName, facts };
      const message = await addMessage({
        conversationId,
        userId,
        role: ConversationRole.ASSISTANT,
        content: factsMessage(doc.fileName, facts.length, language),
        metadata: { intent: "document_facts", cards: [card] } as unknown as Prisma.InputJsonValue,
      });
      await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });
      messageId = message.id;
    }
    await prisma.document.update({ where: { id: doc.id }, data: { knowledge: { status: "done", facts, ...(messageId ? { messageId } : {}) } as unknown as Prisma.InputJsonValue } });
  } catch (error) {
    console.warn("Could not learn from document", error instanceof Error ? error.message : error);
    await prisma.document.updateMany({ where: { id: documentId, userId }, data: { knowledge: { status: "done", facts: [] } as unknown as Prisma.InputJsonValue } }).catch(() => undefined);
  }
}

/** The user's choice on the facts card: the ticked facts go into memory (deduplicated by rememberFact). */
export async function keepFacts(userId: string, documentId: string, keepIds: string[]): Promise<{ kept: number } | null> {
  const doc = await prisma.document.findFirst({ where: { id: documentId, userId }, select: { id: true, fileName: true, knowledge: true } });
  const knowledge = doc?.knowledge as Knowledge | null;
  if (!doc || !knowledge) return null;
  const chosen = knowledge.facts.filter((f) => keepIds.includes(f.id));
  for (const f of chosen) await rememberFact(userId, { kind: f.kind, content: f.content, source: `document:${doc.id}`, importance: 0.6, metadata: { documentId: doc.id, fileName: doc.fileName } });
  const kept = chosen.map((f) => f.id);
  await prisma.document.update({ where: { id: doc.id }, data: { knowledge: { ...knowledge, decided: true, kept } as unknown as Prisma.InputJsonValue } });
  // The card in the chat shows the choice from now on (also after reloading the chat).
  if (knowledge.messageId) {
    const message = await prisma.conversationMessage.findFirst({ where: { id: knowledge.messageId, userId } });
    const meta = (message?.metadata ?? {}) as { cards?: Array<Record<string, unknown>> };
    if (message && meta.cards) {
      const cards = meta.cards.map((c) => (c.type === "document_facts" && c.documentId === doc.id ? { ...c, kept } : c));
      await prisma.conversationMessage.update({ where: { id: message.id }, data: { metadata: { ...meta, cards } as unknown as Prisma.InputJsonValue } });
    }
  }
  return { kept: kept.length };
}

/**
 * A question answered from the user's documents, or null (no documents, nothing close enough, no model, or an answer
 * the pieces don't back up) so the chat carries on as before.
 */
export async function answerFromDocuments(userId: string, question: string, language: string): Promise<{ answer: string; fileName: string } | null> {
  const ai = getAi();
  if (!ai.available) return null;
  const chunks = await prisma.documentChunk.findMany({ where: { userId }, select: { text: true, embedding: true, embeddingModel: true, document: { select: { fileName: true } } }, take: 2000 });
  if (!chunks.length) return null;
  const { model, vector } = await embedOne(question, "query");
  const floor = relevanceFloor(model) + 0.05;
  const top = chunks
    .map((c) => ({ c, score: c.embeddingModel === model && c.embedding.length ? cosineSimilarity(vector, c.embedding) : fuzzySimilarity(question, c.text) * 0.8 }))
    .filter((s) => s.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if (!top.length) return null;
  const excerpts = top.map((s, i) => `[${i + 1}] (${s.c.document.fileName})\n${truncate(s.c.text, 900)}`).join("\n\n");
  const result = await ai.json(
    [
      {
        role: "system",
        content: `Answer the user's question using ONLY the numbered excerpts from their own documents. If the excerpts don't contain the answer, return found=false. Otherwise give a short answer (at most 2 sentences${language === "ur" ? ", in Urdu" : ""}) and the number of the excerpt it came from.`,
      },
      { role: "user", content: `Excerpts:\n${excerpts}\n\nQuestion: ${question}` },
    ],
    answerSchema,
    { json: ANSWER_JSON, maxTokens: 200, timeoutMs: 45000 },
  ).catch(() => null);
  if (!result?.found || !result.answer.trim()) return null;
  const source = top[result.excerpt - 1] ?? top[0];
  if (!answerGrounded(result.answer, source.c.text)) return null;
  return { answer: result.answer.trim(), fileName: source.c.document.fileName };
}
