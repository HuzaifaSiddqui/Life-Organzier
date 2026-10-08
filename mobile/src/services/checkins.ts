import AsyncStorage from "@react-native-async-storage/async-storage";
import { auth } from "../lib/firebase";
import type { Task } from "../types/models";
import { api, isNetworkError } from "./api";
import { readTasks, subscribeSync, writeTasks } from "./syncEngine";

/**
 * FR-RN-004 check-ins on the phone. The server's respond endpoint is the source of truth: it records
 * the answer with the tap time and applies the task change in one versioned write. The phone only
 * patches its local task cache optimistically (no extra sync mutation, which would double-write and
 * lose the tap time) and queues answers made offline, sending them with their original tap time.
 */

export type CheckinKind = "START" | "START_FOLLOWUP" | "COMPLETION" | "COMPLETION_EXTRA";
export type CheckinCategory = "START" | "COMPLETION";
export type CheckinResponse =
  | "STARTED"
  | "NOT_TODAY"
  | "DONE"
  | "PLUS_30"
  | "MORE_15"
  | "MORE_60"
  | "PARTIAL_25"
  | "PARTIAL_50"
  | "PARTIAL_75"
  | "DIDNT";

export type PlannedCheckin = {
  id: string;
  taskId: string;
  kind: CheckinKind;
  category: CheckinCategory;
  fireAt: string;
  title: string;
  body: string;
  tone: "FUNNY" | "SERIOUS" | "GENTLE";
  offerSplit: boolean;
};

export type SlotSuggestion = { start: string; end: string; ymd: string; reason: string };

export type RespondResult = {
  checkin: { id: string; status: string; response: string | null };
  task: Task | null;
  message: string | null;
  next: PlannedCheckin | null;
  suggestion: SlotSuggestion | null;
  remainingMinutes: number | null;
  deadlineWarning: boolean;
  refused: "limit" | "quiet_hours" | "dnd" | null;
  alreadyAnswered: boolean;
};

type QueuedAnswer = { checkinId: string; taskId: string | null; response: CheckinResponse; respondedAt: string };

const queueKey = () => `life-organizer:checkin-answers:v1:${auth.currentUser?.uid ?? "guest"}`;

async function readQueue(): Promise<QueuedAnswer[]> {
  try {
    const raw = await AsyncStorage.getItem(queueKey());
    const q = raw ? (JSON.parse(raw) as QueuedAnswer[]) : [];
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}

async function writeQueue(q: QueuedAnswer[]): Promise<void> {
  try {
    await AsyncStorage.setItem(queueKey(), JSON.stringify(q));
  } catch {
    // keep going from memory
  }
}

/** Optimistic local change so the app reflects the answer at once; the server result replaces it. */
async function patchLocalTask(taskId: string | null, response: CheckinResponse, at: string, server?: Task | null): Promise<void> {
  if (!taskId) return;
  const tasks = await readTasks();
  const i = tasks.findIndex((t) => t.id === taskId);
  if (i < 0) return;
  if (server) tasks[i] = server;
  else if (response === "STARTED" && tasks[i].status === "PENDING") tasks[i] = { ...tasks[i], status: "IN_PROGRESS", startedAt: tasks[i].startedAt ?? at };
  else if (response === "DONE") tasks[i] = { ...tasks[i], status: "COMPLETED", progress: 100, completedAt: at };
  else if (response.startsWith("PARTIAL_")) tasks[i] = { ...tasks[i], progress: Math.max(tasks[i].progress ?? 0, Number(response.split("_")[1])) };
  else return;
  await writeTasks(tasks);
}

async function send(a: QueuedAnswer): Promise<RespondResult> {
  const res = await api.post(`/checkins/${a.checkinId}/respond`, { response: a.response, respondedAt: a.respondedAt }, { timeout: 30000 });
  const body = res.data as { success: boolean; data: RespondResult; message?: string };
  if (!body.success) throw new Error(body.message ?? "Couldn't save your answer");
  return body.data;
}

/**
 * Answers a check-in. Online → the server result (with any next check-in to schedule). Offline →
 * null after queueing; the answer is sent with its tap time when the connection returns.
 */
export async function answerCheckin(checkinId: string, taskId: string | null, response: CheckinResponse, tappedAt = new Date()): Promise<RespondResult | null> {
  const answer: QueuedAnswer = { checkinId, taskId, response, respondedAt: tappedAt.toISOString() };
  await patchLocalTask(taskId, response, answer.respondedAt);
  try {
    const result = await send(answer);
    await patchLocalTask(taskId, response, answer.respondedAt, result.task);
    return result;
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    const q = await readQueue();
    if (!q.some((x) => x.checkinId === checkinId)) await writeQueue([...q, answer]);
    return null;
  }
}

let flushing = false;
/** Sends answers queued offline. Next check-ins they return are scheduled by the reminder re-sync. */
export async function flushCheckinAnswers(): Promise<number> {
  if (flushing || !auth.currentUser) return 0;
  flushing = true;
  let sent = 0;
  try {
    for (const a of await readQueue()) {
      try {
        const r = await send(a);
        await patchLocalTask(a.taskId, a.response, a.respondedAt, r.task);
      } catch (error) {
        if (isNetworkError(error)) break; // still offline: keep the rest
        // 4xx (deleted check-in, invalid answer): drop it rather than retry forever.
      }
      await writeQueue((await readQueue()).filter((x) => x.checkinId !== a.checkinId));
      sent += 1;
    }
  } finally {
    flushing = false;
  }
  return sent;
}

/** Flush whenever the sync engine reports a successful sync (it runs on reconnect and app foreground). */
export function startCheckinQueue(onFlushed?: () => void): () => void {
  let last: string | null = null;
  return subscribeSync((s) => {
    if (s.online && !s.syncing && s.lastSyncAt && s.lastSyncAt !== last) {
      last = s.lastSyncAt;
      void flushCheckinAnswers().then((n) => {
        if (n) onFlushed?.();
      });
    }
  });
}

/* ---------------------------------------------------------------------------- in-app sheet bus */

export type CheckinSheetState =
  | { mode: "start"; checkinId: string; taskId: string; title: string; body: string }
  | { mode: "update"; checkinId: string; taskId: string; title: string; body: string }
  | { mode: "result"; taskId: string | null; title: string; result: RespondResult | null; response: CheckinResponse };

const sheetListeners = new Set<(s: CheckinSheetState | null) => void>();
let sheetState: CheckinSheetState | null = null;

export function showCheckinSheet(state: CheckinSheetState | null): void {
  sheetState = state;
  sheetListeners.forEach((l) => l(state));
}

export function subscribeCheckinSheet(listener: (s: CheckinSheetState | null) => void): () => void {
  sheetListeners.add(listener);
  listener(sheetState);
  return () => sheetListeners.delete(listener);
}
