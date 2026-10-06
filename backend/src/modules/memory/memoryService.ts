import { ConversationRole, Prisma, type MemoryItem } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../config/db.js";
import { embedOne, embedTexts, embeddingModelName, HASH_EMBED_MODEL } from "../../ai/embeddings.js";
import { getAi } from "../../ai/llm.js";
import { cosineSimilarity, fuzzySimilarity, truncate } from "../../lib/text.js";

/**
 * Long-term memory (semantic + episodic).
 *
 * Retrieval score (inspired by "Generative Agents", Park et al. 2023):
 *   score = 0.55·relevance + 0.25·importance + 0.20·recency,   recency = exp(-ageDays / 30)
 * Vectors live in a Postgres double precision[] column scoped per user; similarity is computed
 * in-process because a single user's memory is small (hundreds of rows). Swapping in pgvector
 * later only changes `candidateMemories`.
 */

export type MemoryKind = "FACT" | "PREFERENCE" | "COPING" | "GOAL" | "EPISODE" | "COURSE" | "CORRECTION";

export type RetrievedMemory = { id: string; kind: string; content: string; score: number; relevance: number };

const DEDUP_THRESHOLD_EMBED = 0.9;
const DEDUP_THRESHOLD_FUZZY = 0.82;

function relevanceFloor(model: string): number {
  return model === HASH_EMBED_MODEL ? 0.12 : 0.5;
}

function recency(date: Date): number {
  const days = (Date.now() - date.getTime()) / 86400000;
  return Math.exp(-days / 30);
}

async function reembedStale(items: MemoryItem[], model: string): Promise<void> {
  const stale = items.filter((m) => m.embeddingModel !== model || !m.embedding.length).slice(0, 64);
  if (!stale.length) return;
  const result = await embedTexts(stale.map((m) => m.content), "document");
  if (result.model !== model) return;
  await Promise.all(
    stale.map((m, i) => {
      m.embedding = result.vectors[i];
      m.embeddingModel = result.model;
      return prisma.memoryItem.update({ where: { id: m.id }, data: { embedding: result.vectors[i], embeddingModel: result.model } });
    }),
  );
}

async function candidateMemories(userId: string, kinds?: string[]): Promise<MemoryItem[]> {
  return prisma.memoryItem.findMany({
    where: { userId, ...(kinds?.length ? { kind: { in: kinds } } : {}) },
    orderBy: { updatedAt: "desc" },
    take: 1500,
  });
}

export async function rememberFact(
  userId: string,
  input: { kind: MemoryKind; content: string; importance?: number; source?: string; metadata?: Prisma.InputJsonValue },
): Promise<{ memory: MemoryItem; reinforced: boolean }> {
  const content = truncate(input.content.replace(/\s+/g, " ").trim(), 500);
  const importance = Math.max(0, Math.min(1, input.importance ?? 0.5));
  const { model, vector } = await embedOne(content, "document");
  const existing = await candidateMemories(userId, [input.kind]);
  let best: { item: MemoryItem; sim: number } | null = null;
  for (const item of existing) {
    const sim =
      item.embeddingModel === model && item.embedding.length ? cosineSimilarity(vector, item.embedding) : fuzzySimilarity(content, item.content);
    const threshold = item.embeddingModel === model && model !== HASH_EMBED_MODEL ? DEDUP_THRESHOLD_EMBED : DEDUP_THRESHOLD_FUZZY;
    if (sim >= threshold && (!best || sim > best.sim)) best = { item, sim };
  }
  if (best) {
    const memory = await prisma.memoryItem.update({
      where: { id: best.item.id },
      data: {
        content,
        importance: Math.min(1, Math.max(best.item.importance, importance) + 0.05),
        reinforcedCount: { increment: 1 },
        embedding: vector,
        embeddingModel: model,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    });
    return { memory, reinforced: true };
  }
  const memory = await prisma.memoryItem.create({
    data: {
      userId,
      kind: input.kind,
      content,
      importance,
      embedding: vector,
      embeddingModel: model,
      source: input.source ?? null,
      metadata: input.metadata ?? Prisma.JsonNull,
    },
  });
  return { memory, reinforced: false };
}

export async function retrieveMemories(
  userId: string,
  query: string,
  opts: { k?: number; kinds?: string[]; minRelevance?: number } = {},
): Promise<RetrievedMemory[]> {
  const items = await candidateMemories(userId, opts.kinds);
  if (!items.length || !query.trim()) return [];
  const { model, vector } = await embedOne(query, "query");
  await reembedStale(items, model);
  const floor = opts.minRelevance ?? relevanceFloor(model);
  const scored = items
    .map((item) => {
      const relevance =
        item.embeddingModel === model && item.embedding.length ? cosineSimilarity(vector, item.embedding) : fuzzySimilarity(query, item.content) * 0.8;
      const score = 0.55 * relevance + 0.25 * item.importance + 0.2 * recency(item.updatedAt);
      return { id: item.id, kind: item.kind, content: item.content, score, relevance };
    })
    .filter((m) => m.relevance >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.k ?? 6);
  if (scored.length) {
    prisma.memoryItem
      .updateMany({ where: { id: { in: scored.map((m) => m.id) } }, data: { accessCount: { increment: 1 }, lastAccessedAt: new Date() } })
      .catch(() => undefined);
  }
  return scored;
}

/** Most important memories regardless of the query — the assistant's "core profile" of the user. */
export async function coreMemories(userId: string, k = 4): Promise<MemoryItem[]> {
  return prisma.memoryItem.findMany({
    where: { userId, kind: { in: ["FACT", "PREFERENCE", "GOAL"] } },
    orderBy: [{ importance: "desc" }, { reinforcedCount: "desc" }, { updatedAt: "desc" }],
    take: k,
  });
}

export async function listMemories(userId: string): Promise<MemoryItem[]> {
  return prisma.memoryItem.findMany({
    where: { userId },
    orderBy: [{ kind: "asc" }, { importance: "desc" }, { updatedAt: "desc" }],
  });
}

export async function deleteMemory(userId: string, id: string): Promise<boolean> {
  const result = await prisma.memoryItem.deleteMany({ where: { id, userId } });
  return result.count > 0;
}

export async function updateMemoryContent(userId: string, id: string, content: string): Promise<MemoryItem | null> {
  const existing = await prisma.memoryItem.findFirst({ where: { id, userId } });
  if (!existing) return null;
  const { model, vector } = await embedOne(content, "document");
  return prisma.memoryItem.update({
    where: { id },
    data: { content: truncate(content.trim(), 500), embedding: vector, embeddingModel: model, importance: Math.max(existing.importance, 0.7) },
  });
}

/* ------------------------------------------------------------------ episodic memory */

type StoredEmbedding = { m: string; v: number[] };

function readEmbedding(value: Prisma.JsonValue | null): StoredEmbedding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.m !== "string" || !Array.isArray(obj.v)) return null;
  return { m: obj.m, v: (obj.v as unknown[]).map(Number) };
}

export async function messageEmbedding(text: string): Promise<Prisma.InputJsonValue> {
  const { model, vector } = await embedOne(text, "document");
  return { m: model, v: vector };
}

/** Recalls related things the user said earlier, across all conversations and channels. */
export async function recallEpisodes(
  userId: string,
  query: string,
  opts: { excludeIds?: string[]; k?: number } = {},
): Promise<Array<{ content: string; createdAt: Date; relevance: number }>> {
  const messages = await prisma.conversationMessage.findMany({
    where: { userId, role: ConversationRole.USER, ...(opts.excludeIds?.length ? { id: { notIn: opts.excludeIds } } : {}) },
    orderBy: { createdAt: "desc" },
    take: 400,
    select: { content: true, createdAt: true, embedding: true },
  });
  if (!messages.length) return [];
  const { model, vector } = await embedOne(query, "query");
  const floor = model === HASH_EMBED_MODEL ? 0.35 : 0.62;
  return messages
    .map((m) => {
      const e = readEmbedding(m.embedding);
      return { content: m.content, createdAt: m.createdAt, relevance: e && e.m === model ? cosineSimilarity(vector, e.v) : 0 };
    })
    .filter((m) => m.relevance >= floor && m.content.length > 12)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, opts.k ?? 3);
}

/* ------------------------------------------------------------------ automatic memory extraction */

type Candidate = { kind: MemoryKind; content: string; importance: number };

const RULES: Array<{ re: RegExp; build: (m: RegExpMatchArray) => Candidate | null }> = [
  {
    re: /\b(?:i|we)\s+(?:really\s+|usually\s+)?(?:prefer|love|enjoy)\s+([^.!?]{3,80})/i,
    build: (m) => ({ kind: "PREFERENCE", content: `User prefers ${m[1].trim()}`, importance: 0.65 }),
  },
  {
    re: /\bi\s+(?:hate|dislike|don'?t like|do not like|can'?t stand)\s+([^.!?]{3,80})/i,
    build: (m) => ({ kind: "PREFERENCE", content: `User dislikes ${m[1].trim()}`, importance: 0.6 }),
  },
  {
    re: /\bi\s+work\s+best\s+([^.!?]{3,60})/i,
    build: (m) => ({ kind: "PREFERENCE", content: `User works best ${m[1].trim()}`, importance: 0.75 }),
  },
  {
    re: /\b([a-z][^.!?,]{2,60}?)\s+(?:really\s+|always\s+)?(?:helps|calms|relaxes|soothes)\s+me\b/i,
    build: (m) => {
      const what = m[1].replace(/^(?:and|but|so|i think|honestly|usually)\s+/i, "").trim();
      return what.split(" ").length <= 8 ? { kind: "COPING", content: `${what.charAt(0).toUpperCase()}${what.slice(1)} helps the user feel better`, importance: 0.8 } : null;
    },
  },
  {
    re: /\bwhen\s+i(?:'m| am)\s+(stressed|anxious|sad|tired|overwhelmed|down|upset)[,\s]+i\s+(?:usually\s+|like to\s+|tend to\s+)?([^.!?]{3,80})/i,
    build: (m) => ({ kind: "COPING", content: `When ${m[1].toLowerCase()}, user ${m[2].trim()}`, importance: 0.8 }),
  },
  {
    re: /\bi\s+listen\s+to\s+([^.!?]{3,60}?)\s+when\s+(?:i(?:'m| am)\s+)?(stressed|sad|anxious|tired|working|studying)/i,
    build: (m) => ({ kind: "COPING", content: `User listens to ${m[1].trim()} when ${m[2].toLowerCase()}`, importance: 0.8 }),
  },
  {
    re: /\bi\s+(?:usually|always|normally|often)\s+([^.!?]{3,80})/i,
    build: (m) => ({ kind: "FACT", content: `User usually ${m[1].trim()}`, importance: 0.55 }),
  },
  {
    re: /\bmy\s+(?:goal|aim|target|dream)\s+(?:is|for this \w+ is)\s+(?:to\s+)?([^.!?]{3,100})/i,
    build: (m) => ({ kind: "GOAL", content: `User's goal is to ${m[1].trim()}`, importance: 0.8 }),
  },
  {
    re: /\bi(?:'m| am)\s+(?:a|an)\s+((?:\w+\s+){0,2}(?:student|teacher|developer|engineer|doctor|nurse|designer|manager|parent|mother|father|freelancer|programmer|lawyer|accountant))(?:\s+(?:at|in|from)\s+([^.!?,]{2,60}))?/i,
    build: (m) => ({ kind: "FACT", content: `User is a ${m[1].trim()}${m[2] ? ` at ${m[2].trim()}` : ""}`, importance: 0.85 }),
  },
  {
    re: /\b(?:call me|my name is)\s+([A-Z]?[a-z]{2,20})\b/i,
    build: (m) => ({ kind: "FACT", content: `User likes to be called ${m[1].charAt(0).toUpperCase()}${m[1].slice(1)}`, importance: 0.9 }),
  },
];

export function ruleBasedMemories(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const rule of RULES) {
    const m = text.match(rule.re);
    if (!m) continue;
    const c = rule.build(m);
    if (c && c.content.length >= 10 && !out.some((o) => o.content === c.content)) out.push(c);
  }
  return out;
}

const llmSchema = z.object({
  memories: z
    .array(
      z.object({
        type: z.enum(["PREFERENCE", "FACT", "COPING", "GOAL"]),
        content: z.string().min(8).max(200),
        importance: z.number().min(1).max(5),
      }),
    )
    .max(3),
});

const LLM_JSON_SCHEMA = {
  type: "object",
  properties: {
    memories: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["PREFERENCE", "FACT", "COPING", "GOAL"] },
          content: { type: "string" },
          importance: { type: "integer", minimum: 1, maximum: 5 },
        },
        required: ["type", "content", "importance"],
      },
    },
  },
  required: ["memories"],
};

const SELF_DISCLOSURE = /\b(i|i'm|im|i am|my|me|myself|mine)\b/i;

/** One-off states and task progress are not long-term memories. */
const TRANSIENT = /\d+\s*%|\b(?:due|deadline|today|tomorrow|tonight|yesterday|this week|right now|currently|at the moment|done with|finished|is working on|has a task|assignment is)\b/i;

/** Small models can invent facts; a memory must be supported by the user's own words. */
function isGrounded(memory: string, source: string): boolean {
  const words = memory
    .toLowerCase()
    .replace(/^user('s)?\s+/, "")
    .match(/[a-z]{4,}/g)
    ?.filter((w) => !["user", "they", "their", "them", "when", "with", "feel", "feels", "helps", "better", "likes", "prefers", "usually", "about", "that", "this", "from", "have", "been"].includes(w)) ?? [];
  if (!words.length) return false;
  const src = source.toLowerCase();
  const hits = words.filter((w) => src.includes(w.slice(0, Math.max(4, w.length - 2)))).length;
  return hits / words.length >= 0.6;
}

export function worthLlmExtraction(text: string): boolean {
  return text.length >= 25 && SELF_DISCLOSURE.test(text);
}

/**
 * Learns durable facts from a user message. Runs after the reply is sent so it never adds latency.
 */
export async function extractAndStoreMemories(
  userId: string,
  text: string,
  opts: { allowLlm: boolean; source?: string; background?: boolean },
): Promise<MemoryItem[]> {
  const candidates = ruleBasedMemories(text);
  if (opts.allowLlm && worthLlmExtraction(text)) {
    const result = await getAi().json(
      [
        {
          role: "system",
          content:
            "You maintain the long-term memory of a personal productivity assistant. From the user's message, extract only DURABLE facts that will still matter in future weeks: preferences (likes, dislikes, preferred times), habits and routines, coping strategies (what helps them relax or feel better), goals, and personal facts (studies, job, family, constraints). Never extract one-off tasks, deadlines, requests, or temporary feelings. Write each memory as one short sentence in third person starting with 'User'. If nothing durable is present return {\"memories\": []}.",
        },
        { role: "user", content: "I have to submit the report by Friday" },
        { role: "assistant", content: '{"memories":[]}' },
        { role: "user", content: text },
      ],
      llmSchema,
      { json: LLM_JSON_SCHEMA, maxTokens: 160, timeoutMs: 45000, background: opts.background ?? true },
    );
    for (const m of result?.memories ?? []) {
      const content = m.content.trim();
      if (!/^user\b/i.test(content)) continue;
      if (TRANSIENT.test(content) || !isGrounded(content, text)) continue;
      candidates.push({ kind: m.type, content, importance: Math.min(1, m.importance / 5) });
    }
  }
  const stored: MemoryItem[] = [];
  for (const c of candidates.slice(0, 4)) {
    try {
      const { memory } = await rememberFact(userId, { ...c, source: opts.source ?? "conversation" });
      stored.push(memory);
    } catch (error) {
      console.warn("Could not store memory", error instanceof Error ? error.message : error);
    }
  }
  return stored;
}

/* ------------------------------------------------------------------ conversation summaries */

const SUMMARY_EVERY = 12;

/** Rolling summary keeps long conversations within the small model's context window. */
const summarizing = new Set<string>();

export async function maybeSummarizeConversation(conversationId: string, userId: string): Promise<void> {
  if (summarizing.has(conversationId)) return;
  summarizing.add(conversationId);
  try {
    await summarize(conversationId, userId);
  } finally {
    summarizing.delete(conversationId);
  }
}

async function summarize(conversationId: string, userId: string): Promise<void> {
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, userId } });
  if (!conversation) return;
  const total = await prisma.conversationMessage.count({ where: { conversationId } });
  if (total - conversation.summarizedCount < SUMMARY_EVERY) return;
  const messages = await prisma.conversationMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    skip: conversation.summarizedCount,
    take: total - conversation.summarizedCount,
    select: { role: true, content: true },
  });
  const transcript = messages.map((m) => `${m.role === "USER" ? "User" : "Assistant"}: ${truncate(m.content, 300)}`).join("\n");
  const summary = await getAi().complete(
    [
      {
        role: "system",
        content:
          "Write a 2-3 sentence third-person summary of what the user discussed with their assistant: what they are working on, how they feel, and what is still open. Start with 'The user'. Do not write dialogue lines. Plain text.",
      },
      { role: "user", content: `${conversation.summary ? `Earlier summary: ${conversation.summary}\n\n` : ""}${transcript}` },
    ],
    { maxTokens: 140, temperature: 0.2, timeoutMs: 60000, background: true },
  );
  const clean = summary ? truncate(summary.replace(/\s+/g, " ").trim(), 600) : "";
  // Reject transcript-like or refusal output from small models; keep counting so we retry later.
  const valid = clean.length >= 40 && !/^(?:user|assistant)\s*:/i.test(clean) && !/\b(?:assistant|user)\s*:/i.test(clean) && !/i'?m sorry|as an ai/i.test(clean);
  await prisma.conversation.updateMany({
    where: { id: conversationId },
    data: valid ? { summary: clean, summarizedCount: total } : { summarizedCount: total },
  });
}
