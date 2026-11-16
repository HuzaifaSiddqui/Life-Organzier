/**
 * Guest mode (FR-OB-003) rules for the app. Tested in __tests__/guest.test.ts.
 */

/** After this long as a guest, the banner asks more firmly ("Sign up to save your data", FR-OB-003 §2). */
export const GUEST_NUDGE_DAYS = 30;

/** How the guest banner speaks: "gentle" in the first 30 days, "firm" after. */
export function guestNudge(createdAt: string | number | Date | null | undefined, now: number): "gentle" | "firm" {
  const t = createdAt == null ? NaN : new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return "gentle";
  return now - t >= GUEST_NUDGE_DAYS * 86_400_000 ? "firm" : "gentle";
}

/** Signed in and allowed into the app: a verified email account, or a guest (no email to verify). */
export function canUseApp(user: { emailVerified: boolean; isAnonymous: boolean } | null | undefined): boolean {
  return Boolean(user && (user.emailVerified || user.isAnonymous));
}
