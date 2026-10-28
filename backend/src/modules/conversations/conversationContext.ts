import { ConversationRole } from "@prisma/client";
import { prisma } from "../../config/db.js";
import type { ChatMessage } from "../../ai/llm.js";
import { maskPersonalNumbers } from "../documents/extraction.js";
import type { QuickAction } from "../assistant/types.js";
import { getOrCreateConversation, readState, saveState } from "./conversationService.js";

/**
 * Short-term context per user and channel (used by the WhatsApp Agent; docs/whatsapp-agent.md "Context window"):
 * the last N turns inside a TTL, capped by an estimated token budget and masked (CNIC and phone numbers), plus
 * the options and the list the last reply showed. It is read-only over the stored conversation: what the user
 * and the assistant said is still saved by the engine. Where it is used:
 *  (a) open questions: when the window has expired, a stale open question (and the "2nd task" list) is dropped
 *      so an old "which day?" can't swallow a new message (dropStaleQuestion);
 *  (b) numbered replies: "1", "2" … pick from `actions`, only while they are inside the window;
 *  (c) the LLM router / intent prompt: `turns` replaces the stored history (trimmed and masked).
 * Dates, data and safety are not decided here: entities.ts, the planners and crisis.ts still own them.
 */

export type ContextOptions = { maxTurns: number; ttlMs: number; maxTokens: number };
export type ContextWindow = {
  turns: ChatMessage[];
  /** Options of the last assistant message, in the order they were numbered; empty once it has expired. */
  actions: QuickAction[];
  /** Task ids of the last list shown (the "2nd one"), from the dialogue state. */
  listed: string[];
  /** Tasks being talked about, most recent first ("it", "that task"). */
  focus: string[];
  lastAt: Date | null;
  expired: boolean;
};

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/** Oldest turns are dropped first until the rest fit; a single long turn is cut. */
export function capTurns(turns: ChatMessage[], maxTokens: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  let used = 0;
  for (const t of [...turns].reverse()) {
    const cost = estimateTokens(t.content);
    if (used + cost > maxTokens) {
      if (!out.length) out.push({ ...t, content: t.content.slice(0, maxTokens * 4) });
      break;
    }
    out.push(t);
    used += cost;
  }
  return out.reverse();
}

export async function loadContext(userId: string, channel: string, now: Date, opts: ContextOptions): Promise<ContextWindow> {
  const since = new Date(now.getTime() - opts.ttlMs);
  const conversation = await prisma.conversation.findFirst({ where: { userId, channel }, orderBy: { lastMessageAt: "desc" } });
  if (!conversation) return { turns: [], actions: [], listed: [], focus: [], lastAt: null, expired: true };
  const rows = await prisma.conversationMessage.findMany({
    where: { conversationId: conversation.id, role: { not: ConversationRole.SYSTEM } },
    orderBy: { createdAt: "desc" },
    take: opts.maxTurns,
    select: { role: true, content: true, metadata: true, createdAt: true },
  });
  const lastAt = rows[0]?.createdAt ?? null;
  const expired = !lastAt || lastAt < since;
  const fresh = rows.filter((r) => r.createdAt >= since).reverse();
  const turns = capTurns(
    fresh.map((r) => ({ role: r.role === ConversationRole.USER ? "user" : "assistant", content: maskPersonalNumbers(r.content) }) as ChatMessage),
    opts.maxTokens,
  );
  const lastAssistant = rows.find((r) => r.role === ConversationRole.ASSISTANT);
  const meta = lastAssistant?.metadata as { actions?: QuickAction[]; expiresAt?: string } | null;
  // Reminder messages carry their own expiry (a reminder can be answered for hours); everything else lives in the window.
  const until = meta?.expiresAt ? new Date(meta.expiresAt) : lastAssistant ? new Date(lastAssistant.createdAt.getTime() + opts.ttlMs) : null;
  const actions = lastAssistant === rows[0] && until && now <= until && Array.isArray(meta?.actions) ? meta.actions : [];
  const state = readState(conversation);
  return { turns, actions, listed: expired ? [] : (state.listed ?? []), focus: state.focus, lastAt, expired };
}

/** (a) After the window has expired, an open question and the numbered list are no longer what the user answers. */
export async function dropStaleQuestion(userId: string, channel: string, window: ContextWindow): Promise<boolean> {
  if (!window.expired || !window.lastAt) return false;
  const conversation = await getOrCreateConversation(userId, channel);
  const state = readState(conversation);
  if (!state.pending && !(state.listed ?? []).length) return false;
  await saveState(conversation.id, { ...state, pending: null, listed: [] });
  return true;
}
