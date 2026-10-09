/**
 * Delivery policy for check-in answers queued on the phone. Pure (no React Native imports) so the
 * backend test runner can exercise it.
 *
 * A queued answer that keeps failing must not block the queue forever: after MAX_ATTEMPTS failed
 * deliveries or MAX_AGE_MS since the tap, it is dropped (the caller reverts the optimistic local
 * change and logs a warning) and the rest of the queue continues.
 */
export const MAX_ATTEMPTS = 10;
export const MAX_AGE_MS = 48 * 3600000;

/** offline: no response at all (no connection) · timeout · server: 5xx · client: 4xx (final). */
export type DeliveryFailure = "offline" | "timeout" | "server" | "client";

export type AnswerRetryState = { attempts?: number; firstTriedAt?: string; respondedAt: string };

export type FailureDecision<T extends AnswerRetryState> =
  | { action: "keep"; answer: T; stopQueue: boolean }
  | { action: "drop"; reason: "client_error" | "max_attempts" | "max_age" };

/**
 * What to do with one answer after a failed delivery.
 *  - 4xx is final.
 *  - Being offline doesn't count as an attempt (a phone can be offline for hours) and stops this
 *    flush, since every other answer would fail the same way; the age limit still applies.
 *  - Timeouts and 5xx count as attempts and the queue moves on to the next answer.
 */
export function decideAfterFailure<T extends AnswerRetryState>(answer: T, failure: DeliveryFailure, now: Date): FailureDecision<T> {
  if (failure === "client") return { action: "drop", reason: "client_error" };
  const firstTriedAt = answer.firstTriedAt ?? answer.respondedAt;
  const attempts = (answer.attempts ?? 0) + (failure === "offline" ? 0 : 1);
  if (now.getTime() - new Date(firstTriedAt).getTime() >= MAX_AGE_MS) return { action: "drop", reason: "max_age" };
  if (attempts >= MAX_ATTEMPTS) return { action: "drop", reason: "max_attempts" };
  return { action: "keep", answer: { ...answer, attempts, firstTriedAt }, stopQueue: failure === "offline" };
}
