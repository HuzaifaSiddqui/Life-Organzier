import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { select: (o: Record<string, unknown>) => o.default } }));
const { motion } = await import("../../theme/tokens");

describe("motion tokens (UI v2 rule: animations 150–300 ms)", () => {
  it("every UI duration is within 150–300 ms (the skeleton pulse is a loop, not a transition)", () => {
    const { pulse, ...ui } = motion.duration;
    expect(pulse).toBeGreaterThan(300);
    for (const ms of Object.values(ui)) {
      expect(ms).toBeGreaterThanOrEqual(150);
      expect(ms).toBeLessThanOrEqual(300);
    }
  });
  it("pops start smaller than full size and never overshoot", () => {
    for (const s of Object.values(motion.pop)) {
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(1);
    }
  });
});
