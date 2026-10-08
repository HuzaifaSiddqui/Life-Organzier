import { z } from "zod";
import { getAi, type ChatMessage } from "../../ai/llm.js";
import { detectMood, isMood, type MoodDetection } from "../mood/moodService.js";
import { parseCheckinStyle } from "../checkins/style.js";
import { cleanTitle, extractEntities, isHabitLike, type Entities, type ExtractOptions } from "./entities.js";

export const INTENTS = [
  "create_task",
  "create_routine",
  "update_task",
  "complete_task",
  "delete_task",
  "set_progress",
  "query_progress",
  "split_task",
  "query_tasks",
  "plan_day",
  "log_mood",
  "support",
  "read_back",
  "undo",
  "switch_context",
  "greeting",
  "thanks",
  "help",
  "set_checkin_style",
  "confirm",
  "deny",
  "provide_info",
  "smalltalk",
  "unclear",
] as const;
export type Intent = (typeof INTENTS)[number];

export type Understanding = {
  intent: Intent;
  confidence: number;
  source: "rules" | "llm";
  entities: Entities;
  title: string;
  /** Free-text reference to an existing task ("the math assignment", "it"). */
  targetRef: string;
  mood: MoodDetection | null;
  splitParts: string[];
  contextTarget: string | null;
};

const CONFIRM = /^(?:yes|yeah|yep|yup|ya|sure|ok|okay|correct|right|confirm(?:ed)?|do it|sounds good|go ahead|that'?s right|exactly|perfect|y|absolutely|of course|please do|yes please)\b[\s.!]*$/i;
const DENY = /^(?:no|nope|nah|not really|cancel|never ?mind|stop|don'?t|wrong|incorrect|n|no thanks|not now|skip)\b[\s.!]*$/i;
const GREETING = /^(?:hi|hello|hey|hiya|yo|salam|assalam\w*|aoa|good (?:morning|afternoon|evening))\b[\s!.,]*(?:there|assistant)?[\s!.]*$/i;
const THANKS = /^(?:thanks|thank you|thx|ty|great,? thanks|awesome,? thanks|cool,? thanks|perfect,? thanks|ok thanks)\b[\s!.]*$/i;
const HELP = /^(?:help|what can you do|how (?:do|can) (?:i|you) (?:use|work)|what do you do|commands)\??[\s!.]*$/i;
const UNDO = /^\s*(?:undo|revert|take that back|undo (?:that|it|the last (?:change|edit)))\b/i;
const READ_BACK = /\b(?:read (?:back|out|aloud|me)|tell me my tasks out loud|read my (?:tasks|schedule))\b/i;
const PLAN = /\b(?:plan (?:my|the) (?:day|week|tomorrow|morning|evening)|what should i (?:do|work on|focus on|start with)(?: now| next| today| first)?|schedule my (?:day|tasks)|organi[sz]e my (?:day|tasks)|make (?:me )?a plan|when should i (?:do|work on|study)|find (?:me )?(?:a )?(?:time|slot))\b/i;
const QUERY =
  /\b(?:what(?:'s| is| do i have| have i got| are my)|show(?: me)?|list|any|how many|do i have|anything)\b[^.?!]*\b(?:tasks?|to ?dos?|today|tonight|tomorrow|this week|week|due|overdue|pending|schedule|agenda|plans?|left|remaining|deadlines?)\b/i;
const QUERY_PROGRESS = /\bhow (?:much|far)(?: of)?\b[^?]*\b(?:done|complete|completed|finished|progress)\b|\b(?:progress|status) (?:on|of|for)\b/i;
const COMPLETE =
  /\b(?:i\s+)?(?:just\s+|already\s+)?(?:completed|finished|did|submitted|have done|'ve done|ve done|got done|wrapped up)\b|\bmark(?:ed)?\b[^.]*\b(?:as\s+)?(?:done|complete|completed|finished)\b|\b(?:is|are)\s+(?:done|finished|complete|completed)\b|\bdone with\b|\b(?:tick|check) off\b/i;
const DELETE = /\b(?:delete|remove|cancel|drop|get rid of|erase|discard|scrap)\b/i;
const SPLIT = /\b(?:split|divide|break(?:\s+(?:up|down))?|chunk)\b/i;
const UPDATE_VERB = /\b(?:move|reschedule|postpone|push(?:\s+back)?|shift|delay|change|rename|update|edit|bring forward|prepone)\b/i;
const MAKE_IT = /\b(?:make|set|mark)\s+(?:it|this|that|the\s+\w+(?:\s+\w+)?|\w+)\s+(?:as\s+)?(?:urgent|high|low|medium|important|a priority|priority|high priority|low priority|due|for|to|at|on)\b/i;
const SWITCH_CONTEXT = /\b(?:i(?:'m| am)\s+(?:now\s+)?(?:at|in)|switch(?:ing)?\s+(?:context\s+)?to|change\s+context\s+to|i(?:'m| am)\s+(?:back\s+)?(?:home|traveling|travelling))\s+(?:the\s+)?([a-z][a-z ]{1,30})/i;
const SUPPORT =
  /\b(?:i can'?t (?:cope|handle|do this|take it)|i don'?t know what to do|help me (?:cope|deal|calm)|feel(?:ing)? (?:lost|hopeless|stuck|empty)|need to talk|want to talk|can we talk|vent|listen to me|i'?m struggling|struggling with|nobody understands)\b/i;
const PROVIDE_INFO =
  /\b(?:i (?:really )?(?:prefer|like|love|enjoy|hate|dislike|usually|always|normally|work best|study best|tend to)|my (?:goal|name|job|major|university|degree)|call me|helps me|calms me|i(?:'m| am) (?:a|an) (?:\w+ )?(?:student|teacher|developer|engineer|doctor|parent))\b/i;
const CREATE_CUE =
  /\b(?:remind me|add|create|new task|todo|to-do|need to|have to|must|should|got to|gotta|gonna|going to|want to|plan to|don'?t forget|remember to|schedule|book|set (?:a )?reminder|i will|i'?ll)\b/i;
const IMPERATIVE_START =
  /^(?:please\s+)?(?:call|buy|finish|submit|pay|email|study|complete|write|prepare|read|clean|send|book|fix|review|visit|meet|cook|wash|bring|pick up|drop off|practice|revise|attend|go to|take|check|order|apply|register|renew|return|print|upload|file|update my|learn|watch|plan|organize|research|draft|design|code|build|deploy|test|reply|contact|follow up)\b/i;
const SMALLTALK =
  /^(?:(?:hi|hey|hello)[,!\s]+)?(?:how are you|how(?:'s| is) it going|how do you do|what'?s up|who are you|what are you|are you (?:there|real|a bot|human)|tell me (?:a joke|about yourself)|good (?:night|job)|nice|cool|lol|haha|ok cool)\b/i;
const ASK_TO_UPDATE =
  /\b(?:(?:can|could|would) you|please)\s+(?:also\s+)?(?:move|reschedule|postpone|push|shift|change|delay)\b|\b(?:move|reschedule|postpone|push|shift|delay)\s+(?:it|this|that|them)\b/i;
const QUESTION =/\?\s*$|^(?:what|when|where|why|how|who|which|can|could|should|would|is|are|do|does|did)\b/i;

function splitParts(text: string): string[] {
  const m = text.match(/\binto\s+(.+)$/i) ?? text.match(/\bin\s+((?:\d+|two|three|four|five|six)\s+(?:parts|pieces|chunks|steps|sessions).*)$/i);
  if (!m) return [];
  const list = m[1].replace(/[.!?]+$/, "");
  // "Chapter 1, 2, 3" → "Chapter 1", "Chapter 2", "Chapter 3"
  const parts = list.split(/\s*(?:,|;|\band\b|&|\+)\s*/i).map((p) => p.trim()).filter(Boolean);
  const prefix = parts[0]?.match(/^(.*?)(\d+)$/);
  if (prefix && prefix[1].trim()) {
    return parts.map((p) => (/^\d+$/.test(p) ? `${prefix[1].trim()} ${p}` : p)).slice(0, 12);
  }
  const counted = m[1].match(/^(\d+|two|three|four|five|six)\s+(?:parts|pieces|chunks|steps|sessions)/i);
  if (counted) {
    const n = Number(counted[1]) || ({ two: 2, three: 3, four: 4, five: 5, six: 6 } as Record<string, number>)[counted[1].toLowerCase()];
    return Array.from({ length: Math.min(n, 12) }, (_, i) => `Part ${i + 1}`);
  }
  return parts.slice(0, 12);
}

function targetFromText(text: string, intent: Intent): string {
  // `text` is the entity residual (dates/times already removed), so only a dangling preposition
  // like "move it to ?" remains at the end.
  let t = text.toLowerCase().replace(/[?.!,]+\s*$/, "");
  if (intent === "update_task") t = t.replace(/\s(?:to|by|on|at|for|until|till|until)\s*$/, " ");
  t = t.replace(/\b\d{1,3}\s*(?:%|percent)\b/g, " ");
  t = t.replace(
    /\b(?:i'?m|i am|i|just|already|have|has|completed|finished|did|submitted|done|with|mark(?:ed)?|as|complete|delete|remove|cancel|drop|get rid of|erase|from (?:my |the )?(?:list|tasks?)|move|reschedule|postpone|push back|push|shift|delay|change|rename|update|edit|make|set|split|divide|break down|break up|break|chunk|into .*$|how much|how far|of|is|are|the|my|a|an|to|it'?s|please|can you|could you|task|progress on|progress of|status of|percent|through|halfway|half|almost|nearly|urgent|important|high|low|medium|priority|need|want|finish|start|work on|stuff|thing|things|can|could|would|you|it|this|that|so|also|now|later|again|really|one|down|up|when|due|deadline|what time|what)\b/g,
    " ",
  );
  return t.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function rulesIntent(text: string, e: Entities, mood: MoodDetection | null): { intent: Intent; confidence: number } {
  const t = text.trim();
  const words = t.split(/\s+/).length;
  if (parseCheckinStyle(t)) return { intent: "set_checkin_style", confidence: 0.95 };
  if (CONFIRM.test(t)) return { intent: "confirm", confidence: 0.95 };
  if (DENY.test(t) && words <= 4) return { intent: "deny", confidence: 0.9 };
  if (GREETING.test(t)) return { intent: "greeting", confidence: 0.95 };
  if (SMALLTALK.test(t)) return { intent: "smalltalk", confidence: 0.9 };
  if (THANKS.test(t)) return { intent: "thanks", confidence: 0.95 };
  if (HELP.test(t)) return { intent: "help", confidence: 0.95 };
  if (UNDO.test(t)) return { intent: "undo", confidence: 0.95 };
  if (READ_BACK.test(t)) return { intent: "read_back", confidence: 0.9 };
  if (SWITCH_CONTEXT.test(t) && !CREATE_CUE.test(t)) return { intent: "switch_context", confidence: 0.85 };
  if (QUERY_PROGRESS.test(t)) return { intent: "query_progress", confidence: 0.9 };
  if (e.progress !== null && /\b(?:done|complete|completed|finished|through|with|on)\b/i.test(t)) return { intent: "set_progress", confidence: 0.9 };
  if (SPLIT.test(t) && /\b(?:into|in)\s+\S+/i.test(t)) return { intent: "split_task", confidence: 0.9 };
  if (/^\s*break\s+(?:it|this|that)?\s*down\b/i.test(t)) return { intent: "split_task", confidence: 0.8 };
  if (PLAN.test(t)) return { intent: "plan_day", confidence: 0.85 };
  if (QUERY.test(t) && !CREATE_CUE.test(t) && (QUESTION.test(t) || /^(?:show|list)/i.test(t))) return { intent: "query_tasks", confidence: 0.85 };
  // "X helps me when I'm stressed" shares a coping strategy — it is not a mood report.
  if (PROVIDE_INFO.test(t) && !e.date && !e.timeExplicit && !e.frequency && !/\b(?:remind me|add|create)\b/i.test(t)) {
    return { intent: "provide_info", confidence: 0.85 };
  }
  if (mood && mood.explicit && !e.date && !e.time && !e.frequency) {
    return { intent: "log_mood", confidence: mood.confidence };
  }
  if (SUPPORT.test(t)) return { intent: "support", confidence: 0.85 };
  if (COMPLETE.test(t) && !e.date && !e.frequency && !/\b(?:by|due|before|until)\b/i.test(t)) return { intent: "complete_task", confidence: 0.85 };
  if (DELETE.test(t) && !e.frequency && !/\b(?:remind|add|create)\b/i.test(t)) return { intent: "delete_task", confidence: 0.85 };
  if (ASK_TO_UPDATE.test(t) && (e.date || e.time || e.priority || e.durationMinutes || /\bto\b/i.test(t))) return { intent: "update_task", confidence: 0.9 };
  if (MAKE_IT.test(t) || (UPDATE_VERB.test(t) && (e.date || e.time || e.priority || e.durationMinutes || /\b(?:to|rename|title)\b/i.test(t)))) {
    if (!/^(?:i\s+)?(?:need|have|want|must|remind)/i.test(t)) return { intent: "update_task", confidence: 0.85 };
  }
  if (mood && !e.date && !e.time) return { intent: "log_mood", confidence: mood.confidence * 0.9 };
  if (e.frequency) return { intent: "create_routine", confidence: 0.85 };
  if (isHabitLike(t) && !e.date && !e.timeExplicit && words <= 6 && !/\b(?:remind me|today|tomorrow)\b/i.test(t)) {
    return { intent: "create_routine", confidence: 0.8 };
  }
  if (PROVIDE_INFO.test(t) && !e.date && !e.timeExplicit && !CREATE_CUE.test(t) && !IMPERATIVE_START.test(t)) return { intent: "provide_info", confidence: 0.8 };
  // Questions are conversation, not tasks — unless they explicitly ask for one ("can you remind me…").
  if (QUESTION.test(t) && !CREATE_CUE.test(t) && !IMPERATIVE_START.test(t)) return { intent: "smalltalk", confidence: 0.7 };
  if (CREATE_CUE.test(t) || IMPERATIVE_START.test(t) || e.date || e.time || e.durationMinutes) {
    const strong = Boolean(e.date || e.time || /\b(?:remind me|add|create|todo|task)\b/i.test(t) || IMPERATIVE_START.test(t));
    return { intent: "create_task", confidence: strong ? 0.85 : 0.6 };
  }
  if (isHabitLike(t) && words <= 5) return { intent: "create_routine", confidence: 0.6 };
  if (QUESTION.test(t)) return { intent: "smalltalk", confidence: 0.4 };
  if (words <= 3) return { intent: "create_task", confidence: 0.4 };
  return { intent: "unclear", confidence: 0.2 };
}

const LLM_INTENTS = [
  "create_task",
  "create_routine",
  "update_task",
  "complete_task",
  "delete_task",
  "query_tasks",
  "plan_day",
  "log_mood",
  "support",
  "provide_info",
  "set_checkin_style",
  "smalltalk",
  "unclear",
] as const;

const llmSchema = z.object({
  intent: z.enum(LLM_INTENTS),
  task_title: z.string().default(""),
  target_task: z.string().default(""),
  mood: z.string().default("none"),
});

const LLM_JSON_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: [...LLM_INTENTS] },
    task_title: { type: "string" },
    target_task: { type: "string" },
    mood: { type: "string", enum: ["none", "stressed", "anxious", "happy", "tired", "motivated", "sad", "overwhelmed", "focused", "calm"] },
  },
  required: ["intent", "task_title", "target_task", "mood"],
};

const SYSTEM = `You are the language-understanding module of a personal productivity assistant.
Classify the user's LAST message using the conversation for context. Intents:
- create_task: wants to add a one-off task/reminder/event
- create_routine: a recurring habit (daily, weekly...)
- update_task: change an existing task (date, time, priority, title)
- complete_task: says an existing task is done
- delete_task: remove an existing task
- query_tasks: asks what tasks they have
- plan_day: asks what to do now or to plan/schedule their time
- log_mood: tells how they feel
- support: wants emotional support or to talk about a problem
- provide_info: shares a fact or preference about themselves
- set_checkin_style: wants check-in/reminder messages funnier, more serious or gentler, or check-ins turned off/on
- smalltalk: chit-chat or a general question
- unclear: impossible to tell
task_title: short actionable title (2-6 words) without dates, times or filler like "remind me", or "" if not a task.
target_task: words naming the existing task the user refers to, or "".
mood: the feeling expressed, or "none".`;

const FEW_SHOT: ChatMessage[] = [
  { role: "user", content: "Last message: i should probably get the car serviced before the trip" },
  { role: "assistant", content: '{"intent":"create_task","task_title":"Get car serviced","target_task":"","mood":"none"}' },
  { role: "user", content: "Last message: ugh the physics thing is killing me, i'm done with it already" },
  { role: "assistant", content: '{"intent":"complete_task","task_title":"","target_task":"physics","mood":"tired"}' },
  { role: "user", content: "Last message: I need to do math" },
  { role: "assistant", content: '{"intent":"unclear","task_title":"Do math","target_task":"","mood":"none"}' },
];

export async function understand(
  text: string,
  opts: ExtractOptions & { history: ChatMessage[]; pendingHint?: string | null; memoryHint?: string | null; allowLlm: boolean },
): Promise<Understanding> {
  const entities = extractEntities(text, opts);
  const mood = detectMood(text);
  const rule = rulesIntent(text, entities, mood);
  let intent = rule.intent;
  let confidence = rule.confidence;
  let source: Understanding["source"] = "rules";
  let title = cleanTitle(entities.residual);
  let targetRef = targetFromText(entities.residual, intent);
  let moodOut = mood;

  const needsLlm = rule.confidence < 0.75 || ((intent === "create_task" || intent === "create_routine") && title.split(/\s+/).length > 7);
  const ai = getAi();
  if (needsLlm && opts.allowLlm && ai.enabled && ai.available) {
    const history = opts.history.slice(-4).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 160)}`).join("\n");
    const result = await ai.json(
      [
        { role: "system", content: SYSTEM },
        ...FEW_SHOT,
        {
          role: "user",
          content: `${history ? `Conversation so far:\n${history}\n\n` : ""}${opts.pendingHint ? `Assistant is waiting for: ${opts.pendingHint}\n` : ""}${opts.memoryHint ? `Known about user: ${opts.memoryHint}\n` : ""}Last message: ${text}`,
        },
      ],
      llmSchema,
      { json: LLM_JSON_SCHEMA, maxTokens: 80, timeoutMs: 20000 },
    );
    if (result) {
      source = "llm";
      const llmIntent = result.intent as Intent;
      // Rules win when they were fairly confident and the LLM disagrees on something structural.
      if (rule.confidence < 0.75 || llmIntent === intent) {
        intent = llmIntent;
        confidence = Math.max(0.6, rule.confidence);
      }
      const llmTitle = cleanTitle(result.task_title ?? "");
      if ((intent === "create_task" || intent === "create_routine") && llmTitle && llmTitle.length >= 2 && llmTitle.length <= 80) {
        if (!title || title.split(/\s+/).length > 6 || /^(?:i|it|this|that|to)\b/i.test(title)) title = llmTitle;
      }
      if (result.target_task && !targetRef) targetRef = result.target_task.toLowerCase();
      if (!moodOut && result.mood && result.mood !== "none" && isMood(result.mood)) {
        moodOut = { mood: result.mood, confidence: 0.7, explicit: false };
      }
    }
  }

  const contextMatch = text.match(SWITCH_CONTEXT);
  return {
    intent,
    confidence,
    source,
    entities,
    title,
    targetRef: targetFromText(targetRef, intent),
    mood: moodOut,
    splitParts: intent === "split_task" ? splitParts(text) : [],
    contextTarget: contextMatch ? contextMatch[1].trim() : null,
  };
}
