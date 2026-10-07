import { getAi, type ChatMessage } from "../../ai/llm.js";
import { z } from "zod";

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  ur: "Urdu",
  ar: "Arabic",
  es: "Spanish",
  fr: "French",
  zh: "Chinese",
  hi: "Hindi",
};

export type ReplyMode = "chat" | "support" | "mood";

function systemPrompt(mode: ReplyMode, contextBlock: string, language: string): string {
  const lang = LANGUAGE_NAMES[language] ?? "English";
  const role =
    mode === "chat"
      ? "Answer briefly and helpfully. If the user seems to want something done (a task, routine, plan), tell them exactly what to say, e.g. 'Say: remind me to call Ali tomorrow at 5 PM'."
      : "Respond with warmth and empathy, like a caring friend — not clinically. Acknowledge the feeling first, then ask one gentle question or offer one small practical step. Use what helped the user before if it is listed. You are a supportive assistant, not a therapist: if they mention serious or long-lasting distress, gently suggest talking to a professional.";
  return `You are Life Organizer, the user's personal AI productivity assistant. You remember the user across conversations.
${role}
Rules: at most 3 short sentences (under 60 words). Speak directly to the user. Use the context naturally — never list it back or mention "context". Never invent tasks, dates or facts that are not in the context. No markdown. Reply in ${lang}.

CONTEXT
${contextBlock}`;
}

export async function generateReply(args: {
  mode: ReplyMode;
  contextBlock: string;
  history: ChatMessage[];
  userText: string;
  language: string;
  instruction?: string;
}): Promise<string | null> {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(args.mode, args.contextBlock, args.language) },
    ...args.history.slice(-4).map((m) => ({ ...m, content: m.content.slice(0, 300) })),
    { role: "user", content: args.instruction ? `${args.userText}\n\n(${args.instruction})` : args.userText },
  ];
  const text = await getAi().complete(messages, { temperature: args.mode === "chat" ? 0.4 : 0.6, maxTokens: 120, timeoutMs: 60000 });
  if (!text) return null;
  const clean = text
    .replace(/^\s*(?:assistant|life organizer)\s*:\s*/i, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length < 2) return null;
  // Small models occasionally ramble — keep the first ~3 sentences.
  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [clean];
  return sentences.slice(0, 3).join(" ").trim();
}

const subtaskSchema = z.object({ subtasks: z.array(z.string().min(2).max(60)).min(2).max(6) });

/** Uses the LLM to propose meaningful sub-steps ("Research, Design, Implementation"). */
export async function proposeSubtasks(title: string, parts: number): Promise<string[] | null> {
  const result = await getAi().json(
    [
      {
        role: "system",
        content: `Break the user's task into exactly ${parts} sequential sub-steps. Each sub-step is 1-4 words, an action or phase name. Return JSON {"subtasks": [...]}.`,
      },
      { role: "user", content: "Task: Build portfolio website" },
      { role: "assistant", content: '{"subtasks":["Plan content","Design layout","Build pages"]}' },
      { role: "user", content: `Task: ${title}` },
    ],
    subtaskSchema,
    {
      json: { type: "object", properties: { subtasks: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6 } }, required: ["subtasks"] },
      maxTokens: 120,
      timeoutMs: 30000,
    },
  );
  if (!result) return null;
  const list = result.subtasks.map((s) => s.trim()).filter(Boolean).slice(0, parts);
  return list.length === parts ? list : null;
}
