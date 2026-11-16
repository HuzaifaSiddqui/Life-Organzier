import { describe, expect, it } from "vitest";
import { lockReason } from "../featureAccess";

const free = { isPro: false, isGuest: false };
const pro = { isPro: true, isGuest: false };
const guest = { isPro: false, isGuest: true };

describe("feature access", () => {
  it("Pro features are locked for free users with a Try Pro reason", () => {
    expect(lockReason("whatsapp", free)).toBe("pro");
    expect(lockReason("locationReminders", free)).toBe("pro");
    expect(lockReason("analyticsExport", free)).toBe("pro");
  });

  it("Pro users have every feature", () => {
    for (const f of ["whatsapp", "whatsappAgent", "whatsappReminders", "locationReminders", "analyticsExport", "sharing"] as const) {
      expect(lockReason(f, pro)).toBeNull();
    }
  });

  it("sharing is open to free users but needs an account", () => {
    expect(lockReason("sharing", free)).toBeNull();
    expect(lockReason("sharing", guest)).toBe("guest");
  });

  it("guests are asked to create an account first, even for Pro features", () => {
    expect(lockReason("whatsapp", guest)).toBe("guest");
    expect(lockReason("analyticsExport", { isPro: true, isGuest: true })).toBe("guest");
  });
});
