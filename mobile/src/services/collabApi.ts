import axios from "axios";
import type { Priority, TaskType } from "../types/models";
import type { ParticipantState } from "../utils/collab";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "./api";
import { syncNow } from "./syncEngine";

/** Task collaboration (server: /api/collab, COLLAB_TASKS). 404 = the server has it off; the app hides the feature. */

export type Person = { id: string; username: string | null; displayName: string | null; photoUrl: string | null };
export type ConnectionState = "none" | "requested" | "incoming" | "connected";
/** `email`: only when that exact address was searched; `photoUrl`: only for people already connected. */
export type SearchResult = Person & { email: string | null; state: ConnectionState; connectionId: string | null };
export type Connections = {
  connected: Array<{ connectionId: string; user: Person; since: string | null }>;
  incoming: Array<{ connectionId: string; user: Person; at: string }>;
  outgoing: Array<{ connectionId: string; user: Person; at: string }>;
};
export type SharedKind = "ASSIGN" | "COLLAB";
export type Participant = {
  user: Person;
  role: "owner" | "member";
  state: ParticipantState;
  proposedChange: { dueDate: string | null; dueTime: string | null } | null;
  completedAt: string | null;
  /** Why they declined: shown to the owner (and to the member themselves). */
  declineReason?: string | null;
};
export type SharedTask = {
  id: string;
  kind: SharedKind;
  title: string;
  description: string | null;
  dueDate: string | null;
  dueTime: string | null;
  priority: Priority;
  category: string | null;
  durationMinutes: number | null;
  taskType: TaskType;
  revision: number;
  cancelled: boolean;
  createdAt: string;
  updatedAt: string;
  owner: Person;
  isOwner: boolean;
  myStatus: "PENDING" | "ACCEPTED" | "REJECTED" | null;
  /** Asked again because the owner changed it after I accepted. */
  reapproval: boolean;
  myTaskId: string | null;
  participants: Participant[];
  /** Done together: the shared progress and who set it last (null for "only for them"). */
  progress?: number | null;
  progressBy?: string | null;
};
export type Notice = {
  id: string;
  kind: string;
  sharedTaskId: string | null;
  /** My own copy of that task, if I have one (a tap opens it). */
  taskId?: string | null;
  /** A card still waiting for my answer (a tap opens the accept screen). */
  pending?: boolean;
  payload: { title?: string; dueDate?: string | null; dueTime?: string | null; proposed?: { dueDate: string | null; dueTime: string | null }; reason?: string; progress?: number } | null;
  read: boolean;
  createdAt: string;
  actor: Person | null;
};
export type Summary = { username: string | null; requests: number; cards: number; unread: number };
export type OpenTask = { sharedTaskId: string; title: string; kind: SharedKind; ownerIsMe: boolean };
export type SharedDetails = {
  title: string;
  description?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  priority: Priority;
  category?: string | null;
  durationMinutes?: number | null;
  taskType?: TaskType;
};

const isOff = (e: unknown) => axios.isAxiosError(e) && e.response?.status === 404;

/** The summary, or null when the server has collaboration off. */
export async function getCollabSummary(): Promise<Summary | null> {
  try {
    return await apiGet<Summary>("/collab/me");
  } catch (e) {
    if (isOff(e)) return null;
    throw e;
  }
}

export async function saveUsername(username: string): Promise<string> {
  return (await apiPut<{ username: string }>("/collab/username", { username })).username;
}

export async function searchPeople(q: string, signal?: AbortSignal): Promise<SearchResult[]> {
  return (await apiGet<{ users: SearchResult[] }>("/collab/users/search", { params: { q }, signal })).users;
}

export function getConnections(): Promise<Connections> {
  return apiGet("/collab/connections");
}

export function requestConnection(userId: string): Promise<{ state: ConnectionState; connectionId: string }> {
  return apiPost("/collab/connections", { userId });
}

export async function answerConnection(connectionId: string, accept: boolean): Promise<void> {
  await apiPost(`/collab/connections/${connectionId}/${accept ? "accept" : "reject"}`, {});
}

/** Removes a connection (or cancels/declines a request). Open shared tasks between us: returned instead. */
export async function removeConnection(connectionId: string): Promise<{ removed: true } | { removed: false; openTasks: OpenTask[] }> {
  try {
    await apiDelete(`/collab/connections/${connectionId}`);
    return { removed: true };
  } catch (e) {
    if (axios.isAxiosError(e) && e.response?.status === 409) {
      const data = (e.response.data as { data?: { openTasks?: OpenTask[] } } | undefined)?.data;
      return { removed: false, openTasks: data?.openTasks ?? [] };
    }
    throw e;
  }
}

export function getSharedTasks(): Promise<{ cards: SharedTask[]; shared: SharedTask[] }> {
  return apiGet("/collab/tasks");
}

export async function getSharedTask(id: string): Promise<SharedTask> {
  return (await apiGet<{ shared: SharedTask }>(`/collab/tasks/${id}`)).shared;
}

/** Shares a task. A task done together also puts the owner's copy on their timeline: pull it now. */
export async function shareTask(details: SharedDetails, kind: SharedKind, memberIds: string[]): Promise<SharedTask> {
  const { shared } = await apiPost<{ shared: SharedTask }>("/collab/tasks", { ...details, kind, memberIds });
  if (kind === "COLLAB") void syncNow().catch(() => undefined);
  return shared;
}

export async function updateSharedTask(id: string, changes: Partial<SharedDetails>): Promise<SharedTask> {
  const { shared } = await apiPatch<{ shared: SharedTask }>(`/collab/tasks/${id}`, changes);
  void syncNow().catch(() => undefined);
  return shared;
}

/** Accept a card (optionally for my own date/time): my copy is created; pull it so it is on my timeline. */
export async function acceptSharedTask(id: string, mine: { dueDate?: string | null; dueTime?: string | null } = {}): Promise<SharedTask> {
  const { shared } = await apiPost<{ shared: SharedTask }>(`/collab/tasks/${id}/accept`, mine);
  void syncNow().catch(() => undefined);
  return shared;
}

/** A reason is required (plain text, at most 200 characters); the owner sees it. */
export async function declineSharedTask(id: string, reason: string): Promise<SharedTask> {
  const { shared } = await apiPost<{ shared: SharedTask }>(`/collab/tasks/${id}/reject`, { reason: reason.trim() });
  void syncNow().catch(() => undefined);
  return shared;
}

export async function resendSharedTask(id: string, userId: string): Promise<SharedTask> {
  return (await apiPost<{ shared: SharedTask }>(`/collab/tasks/${id}/resend`, { userId })).shared;
}

/** The owner takes someone off the task. */
export async function removeSharedMember(id: string, userId: string): Promise<SharedTask> {
  return (await apiDelete<{ shared: SharedTask }>(`/collab/tasks/${id}/members/${userId}`)).shared;
}

/** A member leaves a shared task (their accepted copy stays theirs). */
export async function leaveSharedTask(id: string): Promise<void> {
  await apiPost(`/collab/tasks/${id}/leave`);
}

export async function cancelSharedTask(id: string): Promise<SharedTask> {
  return (await apiDelete<{ shared: SharedTask }>(`/collab/tasks/${id}`)).shared;
}

export async function getNotices(): Promise<Notice[]> {
  return (await apiGet<{ notices: Notice[] }>("/collab/notices")).notices;
}

export async function markNoticesRead(): Promise<void> {
  await apiPost("/collab/notices/read", {});
}

export async function markNoticeRead(id: string): Promise<void> {
  await apiPost(`/collab/notices/${id}/read`, {});
}
