/**
 * Who can use which feature. Locked features stay visible (dimmed) and a tap explains how to unlock them
 * (components/LockedFeature.tsx). The server checks the same rules (PRO_REQUIRED, guest checks), so this is only
 * what the user sees. Tested in __tests__/featureAccess.test.ts.
 */

export type Feature =
  | "whatsapp" // link a WhatsApp number (FR-WA-001)
  | "whatsappAgent" // the user's own WhatsApp Agent
  | "whatsappReminders" // "Notify on: WhatsApp only"
  | "locationReminders" // FR-LB-001
  | "analyticsExport" // Insights → Export CSV
  | "sharing" // People / shared tasks (needs a real account: others must be able to find you)
  | "proPlan"; // switching to Pro (needs an account to keep it on)

/** "pro": free users see "Try Pro"; "account": guests see "Create an account". */
const RULES: Record<Feature, { pro: boolean; account: boolean }> = {
  whatsapp: { pro: true, account: true },
  whatsappAgent: { pro: true, account: true },
  whatsappReminders: { pro: true, account: true },
  locationReminders: { pro: true, account: true },
  analyticsExport: { pro: true, account: true },
  sharing: { pro: false, account: true },
  proPlan: { pro: false, account: true },
};

export type LockReason = "pro" | "guest";

/**
 * Why a feature is locked for this user, or `null` when it's open. A guest is asked to create an account first
 * (Pro needs an account), so "guest" wins over "pro".
 */
export function lockReason(feature: Feature, user: { isPro: boolean; isGuest: boolean }): LockReason | null {
  const rule = RULES[feature];
  if (user.isGuest && (rule.account || rule.pro)) return "guest";
  if (rule.pro && !user.isPro) return "pro";
  return null;
}
