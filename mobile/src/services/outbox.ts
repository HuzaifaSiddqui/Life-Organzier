import AsyncStorage from "@react-native-async-storage/async-storage";
import axios from "axios";
import * as Network from "expo-network";
import { AppState } from "react-native";
import { auth } from "../lib/firebase";
import type { ApiError, ApiSuccess } from "../types/models";
import { addOp, failureAction, type OutboxMethod, type OutboxOp } from "../utils/outbox";
import { api } from "./api";

/**
 * Changes the user made on screen that the server hasn't confirmed yet (settings, routines, mood, …). Screens
 * update first and call `send()`: it goes out at once, or waits here while offline and goes out on reconnect /
 * app foreground. A change the server refuses is dropped and reported (`onOutboxRejected`) so the screen can undo
 * it and say so. Tasks have their own queue (syncEngine). Rules: utils/outbox.ts.
 */

const keyFor = (uid: string) => `life-organizer:outbox:${uid}`;

async function readQueue(uid: string): Promise<OutboxOp[]> {
  try {
    const list = JSON.parse((await AsyncStorage.getItem(keyFor(uid))) ?? "[]") as OutboxOp[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function writeQueue(uid: string, queue: OutboxOp[]): Promise<void> {
  await AsyncStorage.setItem(keyFor(uid), JSON.stringify(queue)).catch(() => undefined);
}

export type OutboxRejection = { op: OutboxOp; message: string };
const rejectListeners = new Set<(r: OutboxRejection) => void>();
const pendingListeners = new Set<(count: number) => void>();

/** A queued change the server refused (it is already dropped). */
export function onOutboxRejected(listener: (r: OutboxRejection) => void): () => void {
  rejectListeners.add(listener);
  return () => rejectListeners.delete(listener);
}

/** How many changes are waiting to be sent. */
export function onOutboxPending(listener: (count: number) => void): () => void {
  pendingListeners.add(listener);
  return () => pendingListeners.delete(listener);
}

function emitPending(count: number) {
  for (const l of pendingListeners) l(count);
}

async function request<T>(op: Pick<OutboxOp, "method" | "path" | "body">): Promise<T> {
  const res = await api.request<ApiSuccess<T> | ApiError>({ method: op.method, url: op.path, data: op.method === "DELETE" ? op.body : (op.body ?? {}) });
  if (!res.data.success) throw new Error(res.data.message);
  return res.data.data;
}

const statusOf = (e: unknown): number | null => (axios.isAxiosError(e) ? (e.response?.status ?? null) : 500);
const messageOf = (e: unknown): string =>
  axios.isAxiosError<ApiError>(e) ? (e.response?.data?.message ?? e.message) : e instanceof Error ? e.message : "Request failed";

export class OutboxRefused extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

export type SendInput = { method: OutboxMethod; path: string; body?: unknown; key?: string; merge?: boolean; label?: string };

let flushing: Promise<void> | null = null;

/**
 * Sends a change now, or keeps it until the connection is back. Resolves with the server's answer, or `null`
 * when it was queued. Throws `OutboxRefused` when the server refused it right away (the caller undoes it).
 */
export async function send<T = unknown>(input: SendInput): Promise<T | null> {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new OutboxRefused("Not signed in", 401);
  const op: OutboxOp = { ...input, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now() };
  // Older changes still waiting go first, so the server sees them in the order the user made them.
  if ((await readQueue(uid)).length) {
    await enqueue(uid, op);
    void flushOutbox();
    return null;
  }
  try {
    return await request<T>(op);
  } catch (e) {
    if (failureAction(statusOf(e), 0) === "retry") {
      await enqueue(uid, op);
      return null;
    }
    throw new OutboxRefused(messageOf(e), statusOf(e));
  }
}

async function enqueue(uid: string, op: OutboxOp): Promise<void> {
  const next = addOp(await readQueue(uid), op);
  await writeQueue(uid, next);
  emitPending(next.length);
}

/** Sends waiting changes in order; stops at the first one that can't go yet (offline). */
export function flushOutbox(): Promise<void> {
  flushing ??= (async () => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    for (;;) {
      const queue = await readQueue(uid);
      const op = queue[0];
      if (!op) break;
      let drop = true;
      try {
        await request(op);
      } catch (e) {
        const action = failureAction(statusOf(e), op.attempts ?? 0);
        if (action === "retry") {
          const now = await readQueue(uid);
          await writeQueue(uid, now.map((q) => (q.id === op.id ? { ...q, attempts: (q.attempts ?? 0) + 1 } : q)));
          drop = false;
        } else {
          for (const l of rejectListeners) l({ op, message: messageOf(e) });
        }
      }
      if (!drop) break;
      const now = await readQueue(uid);
      const rest = now.filter((q) => q.id !== op.id);
      await writeQueue(uid, rest);
      emitPending(rest.length);
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

export async function pendingCount(): Promise<number> {
  const uid = auth.currentUser?.uid;
  return uid ? (await readQueue(uid)).length : 0;
}

/** Sign-out: unsent changes of that user are dropped with the rest of their local data. */
export async function clearOutbox(uid: string): Promise<void> {
  await AsyncStorage.removeItem(keyFor(uid)).catch(() => undefined);
  emitPending(0);
}

/** Sends waiting changes on start, on reconnect and when the app comes back to the foreground. */
export function startOutbox(): () => void {
  void flushOutbox();
  void pendingCount().then(emitPending);
  const net = Network.addNetworkStateListener((s) => {
    if (s.isConnected && s.isInternetReachable !== false) void flushOutbox();
  });
  const app = AppState.addEventListener("change", (state) => {
    if (state === "active") void flushOutbox();
  });
  return () => {
    net.remove();
    app.remove();
  };
}
