/**
 * Pure rules for the outbox (services/outbox.ts): changes the user made that the server hasn't confirmed yet
 * (settings, routines, mood, …). Tasks have their own queue in syncEngine. Tested in __tests__/outbox.test.ts.
 */

export type OutboxMethod = "POST" | "PUT" | "PATCH" | "DELETE";

export type OutboxOp = {
  id: string;
  method: OutboxMethod;
  path: string;
  body?: unknown;
  /**
   * Same key = same thing being changed. A newer change replaces the queued one (marking a routine done, then
   * skipped, sends only "skipped"). With `merge`, object bodies combine instead (two settings changes → one PUT).
   */
  key?: string;
  merge?: boolean;
  /** What the user did, for the "couldn't save" message ("Settings", "Mood"…). */
  label?: string;
  at: number;
  attempts?: number;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Adds a change to the queue, replacing or merging an older change to the same thing. Order is kept by time. */
export function addOp(queue: OutboxOp[], op: OutboxOp): OutboxOp[] {
  if (!op.key) return [...queue, op];
  const old = queue.find((q) => q.key === op.key);
  if (!old) return [...queue, op];
  const rest = queue.filter((q) => q !== old);
  const body = op.merge && isPlainObject(old.body) && isPlainObject(op.body) ? { ...old.body, ...op.body } : op.body;
  return [...rest, { ...op, body }];
}

/** After this many failed tries on server errors (5xx) a change is given up, so one bad change can't block the rest. */
export const MAX_ATTEMPTS = 8;

/**
 * What to do with a change the server didn't accept:
 * - no response (offline, timeout), 408, 429, 5xx: keep it and try again later;
 * - any other answer (400, 403, 404, 409…): the server refused it, so drop it and undo it on screen.
 */
export function failureAction(status: number | null | undefined, attempts: number): "retry" | "drop" {
  if (status == null || status === 408 || status === 429) return "retry";
  if (status >= 500) return attempts + 1 >= MAX_ATTEMPTS ? "drop" : "retry";
  return "drop";
}
