import { SharedMemberStatus, TaskStatus } from "@prisma/client";

/**
 * Task collaboration (COLLAB_TASKS, default off): the rules with no database, so they are unit-tested on their own.
 * People connect by request; connected people can share a task: ASSIGN (only for them) or COLLAB (done together,
 * the owner has a copy too). A member's copy exists only after they accept the card.
 */

export const collabOn = () => process.env.COLLAB_TASKS?.toLowerCase() === "on";

/** Members per shared task, besides the owner. */
export const MAX_MEMBERS = 10;
export const SEARCH_LIMIT = 15;
/** Shortest username prefix that searches (shorter text finds nobody, so letters can't list everyone). */
export const SEARCH_MIN_CHARS = 3;
/** Per user: searches per minute, connection requests per hour (lib/rateLimit.ts). */
export const SEARCH_PER_MINUTE = 30;
export const REQUESTS_PER_HOUR = 20;

const USERNAME = /^[a-z0-9_]{3,20}$/;

/** "@Ali_Khan " → "ali_khan", or null when it can't be a username (3–20 of a-z, 0-9, _). */
export function normalizeUsername(raw: string): string | null {
  const name = raw.trim().replace(/^@/, "").toLowerCase();
  return USERNAME.test(name) ? name : null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * What a search box text means: a whole email address (matched exactly, never by prefix), or a username prefix of at
 * least SEARCH_MIN_CHARS (a leading "@" is allowed). Names and partial emails are not searched. Null: search nothing.
 */
export function searchTerm(raw: string): { kind: "email"; email: string } | { kind: "username"; prefix: string } | null {
  const text = raw.trim().toLowerCase().slice(0, 120);
  if (EMAIL.test(text)) return { kind: "email", email: text };
  const prefix = text.replace(/^@/, "");
  return /^[a-z0-9_]+$/.test(prefix) && prefix.length >= SEARCH_MIN_CHARS ? { kind: "username", prefix: prefix.slice(0, 20) } : null;
}

/** A participant's state as the shared task view shows it. */
export type ParticipantState = "waiting" | "changed" | "accepted" | "in_progress" | "done" | "declined" | "removed";

/**
 * A member (or a COLLAB owner) as everyone sees them: still to answer, answered no, or how far their own copy is.
 * `copyStatus` is their task's status (null: no copy). An accepted member whose copy was deleted has left it.
 */
export function participantState(member: { status: SharedMemberStatus; reapproval: boolean } | null, copyStatus: TaskStatus | null): ParticipantState {
  if (member?.status === SharedMemberStatus.REJECTED) return "declined";
  if (member?.status === SharedMemberStatus.PENDING) return member.reapproval ? "changed" : "waiting";
  if (copyStatus === null || copyStatus === TaskStatus.DELETED) return "removed";
  if (copyStatus === TaskStatus.COMPLETED) return "done";
  if (copyStatus === TaskStatus.IN_PROGRESS) return "in_progress";
  return "accepted";
}

/** Still to settle between two people: a card not answered yet, or a copy (theirs or the owner's) not done. */
export function isUnsettled(states: ParticipantState[]): boolean {
  return states.some((s) => s === "waiting" || s === "changed" || s === "accepted" || s === "in_progress");
}

/** The details members agreed to. A change to any of them asks every accepted member again. */
export const AGREED_FIELDS = ["title", "description", "dueDate", "dueTime", "durationMinutes"] as const;
export type AgreedField = (typeof AGREED_FIELDS)[number];

const sameValue = (a: unknown, b: unknown) =>
  a instanceof Date || b instanceof Date ? (a as Date | null)?.getTime?.() === (b as Date | null)?.getTime?.() : (a ?? null) === (b ?? null);

/** Which agreed details `next` changes (undefined = not given, left as it is). */
export function changedAgreedFields(prev: Partial<Record<AgreedField, unknown>>, next: Partial<Record<AgreedField, unknown>>): AgreedField[] {
  return AGREED_FIELDS.filter((f) => next[f] !== undefined && !sameValue(prev[f], next[f]));
}

/** A member's own date/time when accepting, if it differs from the card's. */
export function proposedChange(
  card: { dueDate: Date | null; dueTime: string | null },
  mine: { dueDate?: Date | null; dueTime?: string | null },
): { dueDate: string | null; dueTime: string | null } | null {
  const dueDate = mine.dueDate !== undefined ? mine.dueDate : card.dueDate;
  const dueTime = mine.dueTime !== undefined ? mine.dueTime : card.dueTime;
  if (sameValue(dueDate, card.dueDate) && sameValue(dueTime, card.dueTime)) return null;
  return { dueDate: dueDate ? dueDate.toISOString() : null, dueTime: dueTime ?? null };
}

export type NoticeKind =
  | "CONNECTION_REQUEST"
  | "CONNECTION_ACCEPTED"
  | "TASK_INVITE"
  | "TASK_ACCEPTED"
  | "TASK_REJECTED"
  | "TASK_CHANGED"
  | "TASK_TIME_CHANGED"
  | "TASK_CANCELLED"
  | "TASK_COMPLETED"
  | "TASK_MEMBER_REMOVED"
  | "TASK_MEMBER_LEFT";

/** The push for a notice (the app shows its own copy for the in-app list). */
export function pushText(kind: NoticeKind, actor: string, title?: string | null): { title: string; body: string } {
  const t = title ? `"${title}"` : "a task";
  switch (kind) {
    case "CONNECTION_REQUEST":
      return { title: "New request", body: `${actor} wants to connect with you.` };
    case "CONNECTION_ACCEPTED":
      return { title: "Request accepted", body: `${actor} accepted your request. You can now share tasks.` };
    case "TASK_INVITE":
      return { title: "Shared task", body: `${actor} shared ${t} with you. Accept it to add it to your plan.` };
    case "TASK_ACCEPTED":
      return { title: "Task accepted", body: `${actor} accepted ${t}.` };
    case "TASK_REJECTED":
      return { title: "Task declined", body: `${actor} declined ${t}.` };
    case "TASK_CHANGED":
      return { title: "Task changed", body: `${actor} changed ${t}. Please accept it again.` };
    case "TASK_TIME_CHANGED":
      return { title: "Different time", body: `${actor} accepted ${t} for a different time.` };
    case "TASK_CANCELLED":
      return { title: "Task cancelled", body: `${actor} cancelled ${t}.` };
    case "TASK_COMPLETED":
      return { title: "Task done", body: `${actor} finished their part of ${t}.` };
    case "TASK_MEMBER_REMOVED":
      return { title: "Removed from a task", body: `${actor} removed you from ${t}. Your copy is still yours.` };
    case "TASK_MEMBER_LEFT":
      return { title: "Left a task", body: `${actor} left ${t}.` };
  }
}

/** How a person is named to others: "@username", else their display name, else "Someone". */
export function personLabel(u: { username: string | null; displayName: string | null } | null | undefined): string {
  if (!u) return "Someone";
  return u.username ? `@${u.username}` : u.displayName?.trim() || "Someone";
}
