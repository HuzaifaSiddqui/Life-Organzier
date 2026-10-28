import { PER_MINUTE } from "./config.js";

/**
 * Token buckets per connection (one key = one budget): 12 messages, 12 statuses, 12 of each media method and
 * 15 polls a minute. A bucket starts full and refills evenly over the minute. A 429 blocks a bucket until the
 * API's Retry-After (or a minute) has passed.
 */

export type Bucket = keyof typeof PER_MINUTE;
export type Clock = { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> };

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    }),
};

export class TokenBucket {
  private tokens: number;
  private last: number;
  private blockedUntil = 0;

  constructor(private readonly perMinute: number, private readonly clock: Clock) {
    this.tokens = perMinute;
    this.last = clock.now();
  }

  private refill(now: number): void {
    this.tokens = Math.min(this.perMinute, this.tokens + ((now - this.last) * this.perMinute) / 60000);
    this.last = now;
  }

  /** 0 = a token was taken; otherwise how long to wait before trying again. */
  tryTake(): number {
    const now = this.clock.now();
    if (now < this.blockedUntil) return this.blockedUntil - now;
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - this.tokens) * 60000) / this.perMinute);
  }

  /** Nothing until `ms` from now, and the bucket refills only from then (the API said this minute is used up). */
  block(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.clock.now() + ms);
    this.tokens = 0;
    this.last = this.blockedUntil;
  }

  get blockedFor(): number {
    return Math.max(0, this.blockedUntil - this.clock.now());
  }
}

export class ConnectionLimiter {
  private readonly buckets: Record<Bucket, TokenBucket>;

  constructor(readonly clock: Clock = realClock) {
    this.buckets = Object.fromEntries(Object.entries(PER_MINUTE).map(([k, n]) => [k, new TokenBucket(n, clock)])) as Record<Bucket, TokenBucket>;
  }

  /** Waits for a token. False if aborted while waiting. */
  async acquire(bucket: Bucket, signal?: AbortSignal): Promise<boolean> {
    for (;;) {
      if (signal?.aborted) return false;
      const wait = this.buckets[bucket].tryTake();
      if (wait === 0) return true;
      await this.clock.sleep(wait, signal);
    }
  }

  /** A token now or never (for best-effort calls such as read receipts). */
  tryAcquire(bucket: Bucket): boolean {
    return this.buckets[bucket].tryTake() === 0;
  }

  /** After a 429: nothing from this bucket until the API says so (a minute if it doesn't). */
  block(bucket: Bucket, retryAfterMs: number | null): void {
    this.buckets[bucket].block(retryAfterMs ?? 60000);
  }

  blockedFor(bucket: Bucket): number {
    return this.buckets[bucket].blockedFor;
  }
}
