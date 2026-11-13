import { detectCrisis } from "../mood/crisis.js";
import { NEGATIVE, type MoodDetection } from "../mood/moodService.js";

/**
 * CHAT_FIXES_V2: questions about the assistant itself get a short, honest, fixed answer (no model, no task, no
 * support reply). Only what the project can truthfully claim: data tied to the account, AI through the app's own
 * server, personal numbers hidden before any AI, deletion in Settings. No encryption claims, no company claims.
 */
const WHO =
  /^(?:hey |hi |so )?(?:who (?:made|built|created|developed|designed|owns) you|who are you|what are you|who'?s behind (?:you|this app)|are you (?:a bot|an ai|a robot|human|real))\b[\s?.!]*$/i;
const PRIVACY =
  /\b(?:is|are) my (?:data|info(?:rmation)?|tasks?|chats?|messages?) (?:private|safe|secure|protected)\b|\bwho can see my (?:data|tasks?|chats?|messages?)\b|\bwhat (?:do|will) you do with my (?:data|info(?:rmation)?|chats?|messages?)\b|\bdo you (?:sell|share|store) my (?:data|info(?:rmation)?|chats?)\b/i;

export const APP_IDENTITY_REPLY = "I'm your Life Organizer assistant. I help you keep track of tasks, routines and your day.";
export const APP_PRIVACY_REPLY =
  "Your tasks and chats are tied to your account. The assistant runs through the app's own server, and personal numbers like phone or CNIC are hidden before any AI sees them. You can delete your account and data in Settings → Data & account (it's removed after 30 days).";

/**
 * PR D (CHAT_FIXES_V2): a past-tense report of time spent ("I studied for 2 hours today", "spent 90 minutes on
 * chemistry"): acknowledged, never a task. Not with "remind / add / need to / tomorrow" (that asks for something).
 */
const SPENT = /^(?:(?:so|ok|okay|today|yesterday)[,\s]+)?(?:i\s+)?(?:just\s+|already\s+)?(?:(?:have|'ve)\s+)?(studied|worked|read|practi[cs]ed|exercised|revised|coded|wrote|ran|walked|trained|meditated|spent)\b/i;
const ACTIVITY: Record<string, string> = { studied: "studying", worked: "work", read: "reading", practised: "practice", practiced: "practice", exercised: "exercise", revised: "revision", coded: "coding", wrote: "writing", ran: "running", walked: "walking", trained: "training", meditated: "meditation" };
const NOT_A_REPORT = /\b(?:remind|add|create|schedule|need to|have to|must|should|will|tomorrow|tonight|next|later)\b|\?\s*$/i;

function durationWords(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = h ? `${h} ${h === 1 ? "hour" : "hours"}` : "";
  const mins = m ? `${m} ${m === 1 ? "minute" : "minutes"}` : "";
  return [hours, mins].filter(Boolean).join(" ");
}

export function progressReport(text: string, durationMinutes: number | null): string | null {
  const t = text.trim();
  const m = SPENT.exec(t);
  if (!m || !durationMinutes || NOT_A_REPORT.test(t)) return null;
  const verb = m[1].toLowerCase();
  if (verb === "spent") {
    const on = /\bon\s+(?:the\s+|my\s+)?([a-z][\w\s-]{1,40}?)\s*(?:today|yesterday|this \w+)?[.!]*$/i.exec(t)?.[1];
    return `Nice work — ${durationWords(durationMinutes)}${on ? ` on ${on.trim()}` : ""}.`;
  }
  return `Nice work — ${durationWords(durationMinutes)} of ${ACTIVITY[verb] ?? "work"}.`;
}

/** PR B: weather questions ("what's the weather like in Lahore?", "will it rain tomorrow?"): the app can't check. */
/** Not "temperature" ("what temperature for baking?" is not about the weather). */
const WEATHER = /\b(?:weather|forecast|rain(?:ing|s)?|snow(?:ing|s)?|sunny|humid(?:ity)?|mausam|موسم)\b/i;
const ASKS = /\?\s*$|^(?:what(?:'s|s| is| will)?|how(?:'s| is| hot| cold)?|will it|is it|does it|tell me|check|any)\b/i;
const NOT_A_QUESTION = /\b(?:remind|add|create|note|task|if it|in case)\b/i;
const NOT_A_PLACE = new Set(["the", "my", "this", "that", "today", "tomorrow", "tonight", "morning", "evening", "afternoon", "week", "weekend", "here", "there", "general", "a", "an"]);

export function appQuestionReply(text: string): { content: string; intent: "app_identity" | "app_privacy" | "out_of_scope" } | null {
  const t = text.trim();
  if (WHO.test(t)) return { content: APP_IDENTITY_REPLY, intent: "app_identity" };
  if (PRIVACY.test(t)) return { content: APP_PRIVACY_REPLY, intent: "app_privacy" };
  if (WEATHER.test(t) && ASKS.test(t) && !NOT_A_QUESTION.test(t)) {
    // The place is named only when the user named one, capitalised ("in Lahore"; "in the morning" is no place).
    const said = /\b(?:[Ii]n|[Ff]or|[Aa]t)\s+(\p{Lu}[\p{L}-]+)/u.exec(t)?.[1];
    const place = said && !NOT_A_PLACE.has(said.toLowerCase()) ? ` in ${said.charAt(0).toUpperCase()}${said.slice(1)}` : "";
    return { content: `I can't check the weather${place}, so your weather app is the best place for that.`, intent: "out_of_scope" };
  }
  return null;
}

/** Words that say the user is struggling (nlu.ts SUPPORT plus a few explicit ones); used to vet a model's "support". */
const DISTRESS =
  /\b(?:i can'?t (?:cope|handle|do this|take it|go on)|i don'?t know what to do|help me (?:cope|deal|calm)|feel(?:ing)? (?:lost|hopeless|stuck|empty|worthless|alone|low|down|awful|terrible)|need to talk|want to talk|can we talk|vent|listen to me|i'?m struggling|struggling with|nobody understands|giving up|give up|don'?t want to do anything|can'?t get out of bed|too much (?:for me|to handle)|breaking down|falling apart|i'?m (?:not ok|not okay))\b/i;

/**
 * CHAT_FIXES_V2: a model may only turn a message into "support" when the message itself shows distress: a distress
 * phrase, a negative mood the rules detected, or crisis wording (crisis is handled even earlier, unchanged).
 * "who made you?" or "is my data private?" are never support.
 */
export function distressSignal(text: string, mood: MoodDetection | null): boolean {
  return DISTRESS.test(text) || Boolean(mood && NEGATIVE.has(mood.mood)) || detectCrisis(text);
}
