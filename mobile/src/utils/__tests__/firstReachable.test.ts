import { describe, expect, it } from "vitest";
import { firstReachableInOrder } from "../firstReachable";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("firstReachableInOrder", () => {
  it("prefers the earlier candidate even when a later one answers first", async () => {
    const probe = async (c: string) => {
      if (c === "a") {
        await delay(30);
        return true;
      }
      return c === "b";
    };
    expect(await firstReachableInOrder(["a", "b"], probe)).toBe("a");
  });

  it("skips unreachable and throwing candidates", async () => {
    const probe = async (c: string) => {
      if (c === "a") throw new Error("boom");
      return c === "c";
    };
    expect(await firstReachableInOrder(["a", "b", "c"], probe)).toBe("c");
  });

  it("returns null when nothing answers", async () => {
    expect(await firstReachableInOrder(["a", "b"], async () => false)).toBeNull();
    expect(await firstReachableInOrder([], async () => true)).toBeNull();
  });

  it("probes in parallel, so total time is the slowest probe, not the sum", async () => {
    const start = Date.now();
    await firstReachableInOrder(["a", "b", "c", "d"], async () => {
      await delay(50);
      return false;
    });
    expect(Date.now() - start).toBeLessThan(150);
  });
});
