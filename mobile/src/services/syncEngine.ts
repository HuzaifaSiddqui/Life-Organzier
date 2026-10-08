import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Network from "expo-network";
import { AppState } from "react-native";
import { auth } from "../lib/firebase";
import type { Task } from "../types/models";
import { api, isNetworkError } from "./api";

/**
 * Offline-first task store (FR-MS-001..003, FR-EH-001/002).
 *  - every change is applied locally first and queued
 *  - the queue is flushed in one /sync call that also pulls changes from other devices
 *  - creates carry a client id so an interrupted sync never duplicates a task
 *  - failures retry with exponential backoff: 5s, 10s, 20s, 40s, 80s, 160s; after 5 attempts the
 *    user sees "Sync failed. Retry?" and can retry immediately
 */

export type Mutation = {
  mutationId: string;
  op: "create" | "update" | "delete";
  localId?: string;
  taskId?: string;
  baseVersion?: number;
  changes?: Record<string, unknown>;
  clientModifiedAt: string;
};

export type SyncStatus = {
  online: boolean;
  syncing: boolean;
  pending: number;
  failed: boolean;
  lastSyncAt: string | null;
  error: string | null;
};

const BACKOFF = [5, 10, 20, 40, 80, 160];
const MAX_ATTEMPTS = 5;

let status: SyncStatus = { online: true, syncing: false, pending: 0, failed: false, lastSyncAt: null, error: null };
const listeners = new Set<(s: SyncStatus) => void>();
const taskListeners = new Set<() => void>();
let attempts = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<boolean> | null = null;
let started = false;
const localIdMap = new Map<string, string>();

/** Server id assigned to an optimistic local task, once synced. */
export function serverIdFor(localId: string): string | null {
  return localIdMap.get(localId) ?? null;
}

function userKey(): string {
  return auth.currentUser?.uid ?? "guest";
}
const K = {
  tasks: () => `life-organizer:tasks:v2:${userKey()}`,
  queue: () => `life-organizer:queue:v2:${userKey()}`,
  since: () => `life-organizer:since:v2:${userKey()}`,
};

function setStatus(patch: Partial<SyncStatus>): void {
  status = { ...status, ...patch };
  listeners.forEach((l) => l(status));
}

export function getSyncStatus(): SyncStatus {
  return status;
}

export function subscribeSync(listener: (s: SyncStatus) => void): () => void {
  listeners.add(listener);
  listener(status);
  return () => listeners.delete(listener);
}

/** Notified whenever the local task cache changes (screens refresh). */
export function subscribeTasks(listener: () => void): () => void {
  taskListeners.add(listener);
  return () => taskListeners.delete(listener);
}

function notifyTasks(): void {
  taskListeners.forEach((l) => l());
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable — keep working from memory.
  }
}

export async function readTasks(): Promise<Task[]> {
  const list = await readJson<Task[]>(K.tasks(), []);
  return Array.isArray(list) ? list : [];
}

export async function writeTasks(tasks: Task[]): Promise<void> {
  await writeJson(K.tasks(), tasks);
  notifyTasks();
}

export async function readQueue(): Promise<Mutation[]> {
  const q = await readJson<Mutation[]>(K.queue(), []);
  return Array.isArray(q) ? q : [];
}

async function writeQueue(queue: Mutation[]): Promise<void> {
  await writeJson(K.queue(), queue);
  setStatus({ pending: queue.length });
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function isLocalId(id: string): boolean {
  return id.startsWith("local-");
}

/** Coalesces with queued mutations for the same task to keep the queue small. */
export async function enqueue(m: Omit<Mutation, "mutationId" | "clientModifiedAt">): Promise<void> {
  const queue = await readQueue();
  const now = new Date().toISOString();
  const targetId = m.taskId ?? m.localId;
  if (m.op === "update" && targetId) {
    const pendingCreate = queue.find((q) => q.op === "create" && q.localId === targetId);
    if (pendingCreate) {
      pendingCreate.changes = { ...pendingCreate.changes, ...m.changes };
      pendingCreate.clientModifiedAt = now;
      await writeQueue(queue);
      return;
    }
    const pendingUpdate = queue.find((q) => q.op === "update" && q.taskId === targetId);
    if (pendingUpdate) {
      pendingUpdate.changes = { ...pendingUpdate.changes, ...m.changes };
      pendingUpdate.clientModifiedAt = now;
      await writeQueue(queue);
      return;
    }
  }
  if (m.op === "delete" && targetId && isLocalId(targetId)) {
    // Never reached the server: just drop it locally.
    await writeQueue(queue.filter((q) => q.localId !== targetId && q.taskId !== targetId));
    return;
  }
  await writeQueue([...queue, { ...m, mutationId: newId("m"), clientModifiedAt: now }]);
}

type SyncResponse = {
  results: Array<{ mutationId: string; status: string; localId?: string; task?: Task; error?: string }>;
  changes: Task[];
  serverTime: string;
  full: boolean;
};

const prePullHooks = new Set<() => Promise<unknown>>();

/**
 * Work that must reach the server before tasks are pulled (e.g. check-in answers made offline), so
 * the pulled state already includes it and the list doesn't flicker back.
 */
export function addPrePullHook(fn: () => Promise<unknown>): () => void {
  prePullHooks.add(fn);
  return () => prePullHooks.delete(fn);
}

async function runSync(): Promise<boolean> {
  if (!auth.currentUser) return false;
  for (const hook of prePullHooks) await hook().catch(() => undefined);
  const queue = await readQueue();
  const since = await readJson<string | null>(K.since(), null);
  setStatus({ syncing: true, error: null });
  try {
    const res = await api.post("/sync", { mutations: queue, since }, { timeout: 30000 });
    const body = res.data as { success: boolean; data: SyncResponse; message?: string };
    if (!body.success) throw new Error(body.message ?? "Sync failed");
    const { results, changes, serverTime, full } = body.data;

    let tasks = full ? [] : await readTasks();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    // Replace optimistic local tasks with their server copies.
    for (const r of results) {
      if (r.localId && r.task) {
        localIdMap.set(r.localId, r.task.id);
        byId.delete(r.localId);
        byId.set(r.task.id, r.task);
      } else if (r.task) {
        byId.set(r.task.id, r.task);
      }
    }
    for (const t of changes) byId.set(t.id, t);
    if (full) {
      // Keep local-only tasks that haven't synced yet.
      for (const t of await readTasks()) if (isLocalId(t.id) && !results.some((r) => r.localId === t.id)) byId.set(t.id, t);
    }
    tasks = [...byId.values()].filter((t) => t.status !== "DELETED" || (t.deletedAt && Date.now() - Date.parse(t.deletedAt) < 86400000));

    const done = new Set(results.filter((r) => r.status !== "rejected" || r.error === "Task not found").map((r) => r.mutationId));
    const remaining = (await readQueue()).filter((q) => !done.has(q.mutationId));
    await writeQueue(remaining);
    await writeTasks(tasks);
    await writeJson(K.since(), serverTime);
    attempts = 0;
    setStatus({ syncing: false, failed: false, online: true, lastSyncAt: serverTime, error: null });
    return true;
  } catch (error) {
    attempts += 1;
    const offline = isNetworkError(error);
    setStatus({
      syncing: false,
      online: !offline,
      failed: attempts >= MAX_ATTEMPTS,
      error: offline ? "Offline — changes are saved on this phone" : error instanceof Error ? error.message : "Sync failed",
    });
    scheduleRetry();
    return false;
  }
}

function scheduleRetry(): void {
  if (retryTimer || attempts >= MAX_ATTEMPTS + 1) return;
  const delay = BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)] * 1000;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void syncNow();
  }, delay);
}

/** Runs one sync (deduplicated). Returns true on success. */
export function syncNow(): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = runSync().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Manual "Retry" — resets backoff and syncs immediately (FR-EH-002 §2). */
export function retrySync(): Promise<boolean> {
  attempts = 0;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  setStatus({ failed: false });
  return syncNow();
}

/** Starts listeners: sync on reconnect and on app foreground (FR-MS-001 §3). */
export function startSyncEngine(): () => void {
  if (started) return () => undefined;
  started = true;
  void readQueue().then((q) => setStatus({ pending: q.length }));
  const net = Network.addNetworkStateListener((s) => {
    const online = Boolean(s.isConnected && s.isInternetReachable !== false);
    setStatus({ online });
    if (online && auth.currentUser) void retrySync();
  });
  const app = AppState.addEventListener("change", (state) => {
    if (state === "active" && auth.currentUser) void syncNow();
  });
  const periodic = setInterval(() => {
    if (auth.currentUser) void syncNow();
  }, 6 * 3600000);
  return () => {
    started = false;
    net.remove();
    app.remove();
    clearInterval(periodic);
  };
}

/** Clears local data for the signed-in user (e.g. "sync from cloud" after corruption, FR-EH-004). */
export async function resetLocalData(): Promise<void> {
  await AsyncStorage.multiRemove([K.tasks(), K.since()]);
  notifyTasks();
}
