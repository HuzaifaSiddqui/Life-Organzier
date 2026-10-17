import { decideAfterFailure, type AnswerRetryState, type DeliveryFailure } from "./answerQueue";

/**
 * Push tokens to unregister after sign-out, kept until the server confirms (P2). Pure (no React Native
 * imports) so the backend test runner can exercise it. Same retry policy as check-in answers
 * (answerQueue.ts): 4xx is final, being offline doesn't count as an attempt and stops the flush, at most
 * 10 attempts or 48 h. `respondedAt` = when the user signed out.
 */
export type PendingUnregister = AnswerRetryState & { token: string; deviceId: string };

/** Adds a token (once). */
export function enqueueUnregister(queue: PendingUnregister[], item: PendingUnregister): PendingUnregister[] {
  return [...queue.filter((q) => q.token !== item.token), item];
}

/** Registering a token again (signed back in) cancels a pending unregister of it. */
export function withoutToken(queue: PendingUnregister[], token: string): PendingUnregister[] {
  return queue.filter((q) => q.token !== token);
}

/** Delivers in order; returns what is still pending. */
export async function flushUnregisterQueue(
  queue: PendingUnregister[],
  deliver: (item: PendingUnregister) => Promise<void>,
  classify: (error: unknown) => DeliveryFailure,
  now = new Date(),
): Promise<PendingUnregister[]> {
  const remaining: PendingUnregister[] = [];
  for (let i = 0; i < queue.length; i += 1) {
    try {
      await deliver(queue[i]);
    } catch (error) {
      const decision = decideAfterFailure(queue[i], classify(error), now);
      if (decision.action === "drop") continue;
      remaining.push(decision.answer);
      if (decision.stopQueue) return [...remaining, ...queue.slice(i + 1)];
    }
  }
  return remaining;
}
