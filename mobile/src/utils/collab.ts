/** Pure helpers for task collaboration (People & sharing, the task form's "Share with"). Tested in utils/__tests__/collab.test.ts. */

export type PersonLike = { id: string; username: string | null; displayName: string | null };

/**
 * The mention being typed: the text after the last "@" that starts a word, up to the cursor (the end).
 * "Report for @al" → "al"; "@" → ""; "mail me at a@b" → null (not at a word start); "@ali done" → null (finished).
 */
export function activeMention(text: string): string | null {
  const m = /(?:^|\s)@([a-z0-9_.]*)$/i.exec(text);
  return m ? m[1].toLowerCase() : null;
}

/** The text with the mention being typed removed (after a person was picked from the list). */
export function withoutActiveMention(text: string): string {
  return activeMention(text) === null ? text : text.replace(/@[a-z0-9_.]*$/i, "");
}

/** "@username", else the name, else "Someone". */
export function personLabel(p: PersonLike | null | undefined): string {
  if (!p) return "Someone";
  return p.username ? `@${p.username}` : p.displayName?.trim() || "Someone";
}

/** Connections whose username or any word of their name starts with the query; already picked ones left out. */
export function filterPeople<P extends PersonLike>(people: P[], query: string, exclude: string[] = [], limit = 6): P[] {
  const q = query.trim().replace(/^@/, "").toLowerCase();
  const out = people.filter((p) => {
    if (exclude.includes(p.id)) return false;
    if (!q) return true;
    if (p.username?.toLowerCase().startsWith(q)) return true;
    return (p.displayName ?? "").toLowerCase().split(/\s+/).some((w) => w.startsWith(q));
  });
  return out.slice(0, limit);
}

/** Same rule as the server (normalizeUsername): 3–20 of a-z, 0-9, _. Returns the cleaned name or null. */
export function cleanUsername(raw: string): string | null {
  const name = raw.trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_]{3,20}$/.test(name) ? name : null;
}

export type ParticipantState = "waiting" | "changed" | "accepted" | "in_progress" | "done" | "declined" | "removed";
export type StateTone = "success" | "warning" | "neutral" | "info";

/** Each state has a tone and an icon (colour is never the only signal). */
export const STATE_TONE: Record<ParticipantState, StateTone> = {
  waiting: "neutral",
  changed: "warning",
  accepted: "info",
  in_progress: "info",
  done: "success",
  declined: "neutral",
  removed: "neutral",
};
export const STATE_ICON: Record<ParticipantState, "clock" | "info" | "check" | "close" | "trash"> = {
  waiting: "clock",
  changed: "info",
  accepted: "check",
  in_progress: "clock",
  done: "check",
  declined: "close",
  removed: "trash",
};

/** "2 of 3 done" for a shared task's summary line. */
export function doneCount(states: ParticipantState[]): { done: number; total: number } {
  const counted = states.filter((s) => s !== "declined" && s !== "removed");
  return { done: counted.filter((s) => s === "done").length, total: counted.length };
}

/** Server error codes → copy keys (never the server's text). */
export function collabErrorKey(code: string | null, offline: boolean): string {
  if (offline) return "collab.err.offline";
  const known = ["USERNAME_TAKEN", "INVALID_USERNAME", "NOT_CONNECTED", "SHARED_TASK_CANCELLED", "ALREADY_ANSWERED", "OPEN_SHARED_TASKS", "TOO_MANY_MEMBERS"];
  return code && known.includes(code) ? `collab.err.${code}` : "collab.err.generic";
}
