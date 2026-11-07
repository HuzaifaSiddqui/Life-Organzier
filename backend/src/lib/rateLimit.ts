import { setBounded } from "./boundedMap.js";
import { HttpError } from "./http.js";

/**
 * Per-key sliding-window rate limits (e.g. per user per route). In memory, per server process.
 * ponytail: per process; several backend instances would need the counts in Postgres or Redis.
 */
export type RateLimiter = {
  /** Records one use for `key`. Throws HttpError 429 RATE_LIMITED when the window is full (the use isn't recorded). */
  take(key: string, now?: number): void;
  /** Uses left for `key` right now. */
  remaining(key: string, now?: number): number;
  reset(): void;
};

/** Keys kept at once (oldest dropped first), so the map can't grow without bound. */
const MAX_KEYS = 10_000;

export function createRateLimiter(opts: { limit: number; windowMs: number; message?: string }): RateLimiter {
  const hits = new Map<string, number[]>();
  const live = (key: string, now: number) => (hits.get(key) ?? []).filter((t) => now - t < opts.windowMs);
  return {
    take(key, now = Date.now()) {
      const recent = live(key, now);
      if (recent.length >= opts.limit) {
        const retryS = Math.max(1, Math.ceil((recent[0] + opts.windowMs - now) / 1000));
        throw new HttpError(429, "RATE_LIMITED", opts.message ?? `Too many requests. Try again in ${retryS} s.`);
      }
      recent.push(now);
      setBounded(hits, key, recent, MAX_KEYS);
    },
    remaining: (key, now = Date.now()) => Math.max(0, opts.limit - live(key, now).length),
    reset: () => hits.clear(),
  };
}
