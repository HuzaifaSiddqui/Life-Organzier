/**
 * Guest mode (FR-OB-003): someone can use the app without an account. The app signs in with a Firebase anonymous
 * account; the server stores their data like anyone's, marked `isGuest`. Converting links an email to the same
 * Firebase account, so the data stays. Off unless GUEST_MODE=on. Pure rules, tested in tests/guest.test.ts.
 */

export function guestModeOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GUEST_MODE?.trim().toLowerCase() === "on";
}

/** A guest account unused this long is deleted with all its data (an uninstalled app can't come back for it). */
export const GUEST_UNUSED_DAYS = 60;

/** `lastSeenAt` is written at most this often, so it costs one write per user every few hours. */
export const LAST_SEEN_EVERY_MS = 6 * 3_600_000;

export function shouldTouchLastSeen(lastSeenAt: Date | null, now: Date): boolean {
  return !lastSeenAt || now.getTime() - lastSeenAt.getTime() >= LAST_SEEN_EVERY_MS;
}

/** The cut-off for the cleanup job: guests last seen (or, never seen, created) before this are deleted. */
export function staleGuestCutoff(now: Date): Date {
  return new Date(now.getTime() - GUEST_UNUSED_DAYS * 86_400_000);
}

export type TokenIdentity = { uid: string; email?: string; provider?: string };

/**
 * What /auth/sync-user does with a token:
 * - an email: a normal account (a converted guest becomes one here: same uid, now with an email);
 * - no email from an anonymous sign-in with guest mode on: a guest;
 * - otherwise refused.
 */
export function syncDecision(token: TokenIdentity, guestMode: boolean): "account" | "guest" | "guest_mode_off" | "no_email" {
  if (token.email) return "account";
  if (token.provider === "anonymous") return guestMode ? "guest" : "guest_mode_off";
  return "no_email";
}
