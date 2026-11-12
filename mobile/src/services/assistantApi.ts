import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ActionPayload, AssistantReply, Briefing, ChatMessage } from "../types/models";
import { apiGet, apiPost } from "./api";
import { syncNow } from "./syncEngine";
import { scheduleReminderSync } from "./reminders";
import { locationRemindersReady } from "./locationReminders";
import { calendarSyncActive } from "./calendar";

const CONVERSATION_KEY = "life-organizer:conversation:v2";

type RawMessage = { id: string; role: ChatMessage["role"]; content: string; metadata: Record<string, unknown> | null; createdAt: string };

function toChat(m: RawMessage): ChatMessage {
  const meta = (m.metadata ?? {}) as Partial<ChatMessage>;
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    cards: meta.cards ?? [],
    actions: meta.actions ?? [],
    intent: meta.intent,
    speak: meta.speak,
    memoriesUsed: meta.memoriesUsed,
    learned: meta.learned,
  };
}

export async function getStoredConversationId(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(CONVERSATION_KEY);
  } catch {
    return null;
  }
}

async function storeConversationId(id: string): Promise<void> {
  try {
    await AsyncStorage.setItem(CONVERSATION_KEY, id);
  } catch {
    // non-critical
  }
}

export async function loadCurrentConversation(): Promise<{ conversationId: string; messages: ChatMessage[] }> {
  const stored = await getStoredConversationId();
  if (stored) {
    try {
      const { messages } = await apiGet<{ messages: RawMessage[] }>(`/assistant/conversations/${stored}/messages`);
      if (messages.length) return { conversationId: stored, messages: messages.map(toChat) };
    } catch {
      // fall through to the server's current conversation
    }
  }
  const data = await apiGet<{ conversation: { id: string }; messages: RawMessage[] }>("/assistant/conversations/current");
  await storeConversationId(data.conversation.id);
  return { conversationId: data.conversation.id, messages: data.messages.map(toChat) };
}

export async function startNewConversation(): Promise<string> {
  const data = await apiPost<{ conversation: { id: string } }>("/assistant/conversations/new");
  await storeConversationId(data.conversation.id);
  return data.conversation.id;
}

/** Sends text or a one-tap action to the assistant. Long timeout: a local LLM can be slow on CPU. */
export async function sendToAssistant(input: {
  text?: string;
  payload?: ActionPayload;
  label?: string;
  conversationId?: string | null;
  voice?: boolean;
}): Promise<AssistantReply> {
  const reply = await apiPost<AssistantReply>(
    "/assistant/message",
    {
      text: input.text ?? null,
      payload: input.payload ?? null,
      label: input.label ?? null,
      conversationId: input.conversationId ?? null,
      channel: input.voice ? "VOICE" : "APP",
      // The server can't see the phone's toggle: it decides whether a task with a place offers "Turn on".
      locationReminders: await locationRemindersReady(),
      // CALENDAR_SYNC: "am I free …" reads the phone's calendar only when this switch is on.
      calendar: await calendarSyncActive(),
    },
    { timeout: 120000 },
  );
  await storeConversationId(reply.conversationId);
  // The assistant may have created/changed tasks or routines: refresh local state.
  void syncNow();
  scheduleReminderSync(800);
  return { ...reply, message: { ...reply.message, cards: reply.message.cards ?? [], actions: reply.message.actions ?? [] } };
}

export async function getBriefing(): Promise<{ briefing: Briefing; ai: { enabled: boolean; available: boolean } }> {
  return apiGet("/assistant/briefing");
}

/**
 * "Start" anywhere in the app (UI v2: task detail and list rows, as on Home's Next up): the assistant's start_task
 * path, so starting works the same everywhere (keeps the planned slot, never "rescheduled"). Returns the reply's
 * first line for a snackbar; the task list refreshes through the next sync.
 */
export async function startTaskNow(taskId: string): Promise<string> {
  const reply = await sendToAssistant({ payload: { type: "start_task", taskId }, label: "Start" });
  const { syncNow } = await import("./syncEngine");
  void syncNow();
  return reply.message.content.split("\n")[0];
}
