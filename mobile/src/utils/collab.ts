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

/** The text with `p` mentioned where the "@…" being typed was: "@username " (or their name when they have none). */
export function insertMention(text: string, p: PersonLike): string {
  const handle = p.username ? `@${p.username}` : (p.displayName ?? "").trim();
  return `${withoutActiveMention(text)}${handle} `;
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

/**
 * Same rule as the server's search (collabRules.searchTerm): a whole email address, or a username prefix of 3+
 * (a leading "@" allowed). Anything else isn't sent: names and partial emails are never searched.
 */
export function searchable(raw: string): boolean {
  const text = raw.trim().toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return true;
  return /^@?[a-z0-9_]{3,}$/.test(text);
}

/** Mirrors the server (collabRules.DECLINE_REASON_MAX / DECLINE_QUICK_PICKS). */
export const DECLINE_REASON_MAX = 200;
export const DECLINE_QUICK_PICKS = ["Too busy right now", "Not my task", "Wrong time for me"] as const;

/** A reason the server will take: some text, at most 200 characters once trimmed (the server also strips markup). */
export function validReason(raw: string): boolean {
  const t = raw.trim();
  return t.length > 0 && t.length <= DECLINE_REASON_MAX;
}

export type NoticeTarget = { screen: "TaskDetail"; params: { taskId: string } } | { screen: "SharedTaskEdit"; params: { id: string; mode: "accept" } } | { screen: "Collab"; params?: { tab: "requests" | "people" | "shared" } };

/**
 * Where a notice (or its push) opens: a card still waiting for my answer → the accept screen; my own copy of the
 * task → that task; a connection request → People; anything else → the Shared tab.
 */
export function noticeTarget(n: { kind: string; sharedTaskId: string | null; taskId?: string | null; pending?: boolean }): NoticeTarget {
  if (n.sharedTaskId && n.pending) return { screen: "SharedTaskEdit", params: { id: n.sharedTaskId, mode: "accept" } };
  if (n.taskId) return { screen: "TaskDetail", params: { taskId: n.taskId } };
  if (n.kind === "TASK_INVITE" && n.sharedTaskId) return { screen: "SharedTaskEdit", params: { id: n.sharedTaskId, mode: "accept" } };
  if (n.kind.startsWith("CONNECTION_")) return { screen: "Collab", params: { tab: n.kind === "CONNECTION_REQUEST" ? "requests" : "people" } };
  return { screen: "Collab", params: { tab: "shared" } };
}

/** Badge text for an unread count: nothing at 0, "9+" above 9. */
export function badgeText(n: number): string | null {
  return n <= 0 ? null : n > 9 ? "9+" : String(n);
}

/** Server error codes → copy keys (never the server's text). */
export function collabErrorKey(code: string | null, offline: boolean): string {
  if (offline) return "collab.err.offline";
  const known = ["USERNAME_TAKEN", "INVALID_USERNAME", "NOT_CONNECTED", "SHARED_TASK_CANCELLED", "ALREADY_ANSWERED", "OPEN_SHARED_TASKS", "TOO_MANY_MEMBERS", "RATE_LIMITED", "SHARED_TASK_NOT_FOUND", "REASON_REQUIRED"];
  return code && known.includes(code) ? `collab.err.${code}` : "collab.err.generic";
}
