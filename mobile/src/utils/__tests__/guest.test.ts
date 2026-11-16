import { describe, expect, it } from "vitest";
import { canUseApp, GUEST_NUDGE_DAYS, guestNudge } from "../guest";

const NOW = Date.parse("2026-11-16T10:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe("guest banner", () => {
  it("is gentle in the first 30 days and firm after", () => {
    expect(guestNudge(daysAgo(1), NOW)).toBe("gentle");
    expect(guestNudge(daysAgo(GUEST_NUDGE_DAYS - 0.01), NOW)).toBe("gentle");
    expect(guestNudge(daysAgo(GUEST_NUDGE_DAYS), NOW)).toBe("firm");
    expect(guestNudge(daysAgo(90), NOW)).toBe("firm");
  });

  it("an unknown start date stays gentle", () => {
    expect(guestNudge(null, NOW)).toBe("gentle");
    expect(guestNudge("not a date", NOW)).toBe("gentle");
  });
});

describe("who can enter the app", () => {
  it("verified accounts and guests can; unverified email accounts wait for verification", () => {
    expect(canUseApp({ emailVerified: true, isAnonymous: false })).toBe(true);
    expect(canUseApp({ emailVerified: false, isAnonymous: true })).toBe(true);
    expect(canUseApp({ emailVerified: false, isAnonymous: false })).toBe(false);
    expect(canUseApp(null)).toBe(false);
  });
});
