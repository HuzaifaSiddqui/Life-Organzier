/**
 * CHAT_FIXES_V2: the user repairing the conversation, read by rules only (no model, no database).
 */

const STRIP = /[\s.!?]+$/;

/**
 * "I am not asking about X, I am asking about Y", "no, I meant Y": what the user actually wants (Y), worded so it can
 * be answered again: a bare noun phrase ("my completed tasks") becomes "show my completed tasks", unless a question is
 * open (then Y is its answer, as said). Null otherwise.
 */
export function correctionTarget(text: string, questionOpen = false): string | null {
  const t = text.trim();
  const m =
    /^(?:no[,.]?\s+)?i(?:'m| am)\s+not\s+asking\s+(?:about|for)\s+.+?[,;]?\s+(?:but\s+)?(?:i(?:'m| am)\s+)?asking\s+(?:about|for)\s+(.+)$/i.exec(t) ??
    /^(?:no[,.]?\s+)?i\s+mean(?:t)?\s+(.+)$/i.exec(t);
  if (!m) return null;
  const y = m[1].replace(STRIP, "").trim();
  if (y.length < 2) return null;
  return questionOpen || /^(?:what|when|which|how|show|list|move|change|update|delete|complete|finish|add|remind)\b/i.test(y) ? y : `show ${y}`;
}

/** "never mind", "cancel": drops an open "which task?" question (it used to be asked again). */
export const CANCEL_CHOICE = /^(?:no[,.]?\s+)?(?:never ?mind|cancel|forget it|stop|leave it)[\s.!]*$/i;

/** "no, the other one", "the other one". */
export const OTHER_ONE = /^(?:no[,.]?\s+)?(?:i\s+meant\s+)?(?:the\s+)?other\s+(?:one|task)[\s.!]*$/i;

/** "add Sana to the above task", "share it with Ali": people on a task that already exists. Returns the reply. */
const SHARE_EXISTING =
  /^(?:please\s+)?(?:(?:add|invite|include)\s+@?\w+(?:\s+and\s+@?\w+)?\s+(?:to|on|in)\s+(?:it|this|that|the\s+(?:above|previous|last|same)\s+(?:one|task)|(?:this|that)\s+task)|share\s+(?:it|this|that|(?:this|that|the\s+(?:above|previous|last))\s+task)\s+with\s+@?\w+)\b/i;
export function shareExistingReply(text: string, collab: boolean): string | null {
  if (!SHARE_EXISTING.test(text.trim())) return null;
  return collab
    ? 'I can\'t add people to a task that already exists yet. To share a task, add it with their name, for example "finish the slides with @sana".'
    : "Sharing isn't available yet.";
}
