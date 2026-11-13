/**
 * CHAT_FIXES_V2: the user repairing the conversation, read by rules only (no model, no database).
 */

const STRIP = /[\s.!?]+$/;

/**
 * "I am not asking about X, I am asking about Y", "no, I meant Y": what the user actually wants (Y), worded so it can
 * be answered again: a bare noun phrase ("my completed tasks") becomes "show my completed tasks", unless a question is
 * open (then Y is its answer, as said). "I meant to call mom" is a plan, not a correction. Null otherwise.
 */
export function correctionTarget(text: string, questionOpen = false): string | null {
  const t = text.trim();
  const m =
    /^(?:no[,.]?\s+)?i(?:'m| am)\s+not\s+asking\s+(?:about|for)\s+.+?[,;]?\s+(?:but\s+)?(?:i(?:'m| am)\s+)?asking\s+(?:about|for)\s+(.+)$/i.exec(t) ??
    /^(?:no[,.]?\s+)?i\s+mean(?:t)?\s+(?!to\b)(.+)$/i.exec(t);
  if (!m) return null;
  const y = m[1].replace(STRIP, "").trim();
  if (y.length < 2) return null;
  return questionOpen || /^(?:what|when|which|how|show|list|move|change|update|delete|complete|finish|add|remind)\b/i.test(y) ? y : `show ${y}`;
}

/** "no, the other one", "the other one". */
export const OTHER_ONE = /^(?:no[,.]?\s+)?(?:i\s+meant\s+)?(?:the\s+)?other\s+(?:one|task)[\s.!]*$/i;

/** A task that is already there: "it", "that task", "the above task". */
const EXISTING = String.raw`(?:it|this|that|the\s+(?:above|previous|last|same)\s+(?:one|task)|(?:this|that)\s+(?:one|task))`;
const SHARE_IT = new RegExp(String.raw`^(?:please\s+)?share\s+${EXISTING}\s+with\s+@?\w+`, "i");
const ADD_TO_IT = new RegExp(String.raw`^(?:please\s+)?(?:add|invite|include|put)\s+(.+?)\s+(?:to|on|in|into)\s+${EXISTING}[\s.!]*$`, "i");

export type AddToExisting = { content: string; intent: "share_existing" | "add_to_task"; item?: string };

/**
 * "add Sana to the above task", "share it with Ali": people on a task that already exists, which the app can't do yet
 * (sharing works when a task is added). A person is an "@name" or one of the user's connections (`people`, lower
 * case); anything else ("add milk to it") is an item, which a task can't hold either: offered as its own task.
 */
export function addToExistingReply(text: string, collab: boolean, people: string[]): AddToExisting | null {
  const t = text.trim();
  const shareReply = (): AddToExisting => ({
    content: collab ? 'I can\'t add people to a task that already exists yet. To share a task, add it with their name, for example "finish the slides with @sana".' : "Sharing isn't available yet.",
    intent: "share_existing",
  });
  if (SHARE_IT.test(t)) return shareReply();
  const m = ADD_TO_IT.exec(t);
  if (!m) return null;
  const said = m[1].trim();
  const names = said.split(/\s*(?:,|\band\b|&)\s*/i).filter(Boolean);
  if (names.every((n) => /^@\w+$/.test(n) || people.includes(n.toLowerCase()))) return shareReply();
  const item = said.charAt(0).toUpperCase() + said.slice(1);
  return { content: `I can't add things inside a task yet. Want "${item}" as its own task?`, intent: "add_to_task", item };
}
