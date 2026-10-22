/**
 * Work a request starts but doesn't wait for (a push, check-in copy). It is tracked so tests can await it
 * with `backgroundSettled()` instead of sleeping, which raced under load. Failures are swallowed here:
 * each caller already logs its own.
 */
const inflight = new Set<Promise<void>>();

export function background(work: Promise<unknown>): void {
  const tracked: Promise<void> = work.then(
    () => undefined,
    () => undefined,
  );
  inflight.add(tracked);
  void tracked.finally(() => inflight.delete(tracked));
}

/** Resolves when all background work (including work it starts) has finished. */
export async function backgroundSettled(): Promise<void> {
  while (inflight.size) await Promise.all([...inflight]);
}
