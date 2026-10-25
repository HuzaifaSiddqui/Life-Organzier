import { describe, expect, it } from "vitest";
import type { Task } from "../../types/models";
import { MAX_SPEECH_HINTS, speechHints } from "../speechHints";

const task = (title: string, o: Partial<Task> = {}) => ({ id: title, title, status: "PENDING", tags: [], locations: [], ...o }) as unknown as Task;

describe("speechHints", () => {
  it("places, course codes and tags of open tasks only; no repeats; done tasks left out", () => {
    const hints = speechHints([
      task("Eat burger", { locations: [{ name: "KFC" }] as Task["locations"] }),
      task("CSC461 assignment 3", { tags: ["fyp"] }),
      task("Old thing", { status: "COMPLETED", locations: [{ name: "Old Place" }] as Task["locations"] }),
      task("Call mom's doctor about results", { tags: ["FYP"] }),
    ]);
    expect(hints).toEqual(["KFC", "CSC461", "fyp"]);
  });
  it("never sends a task title", () => {
    expect(speechHints([task("Take medicine for anxiety"), task("Pay rent")])).toEqual([]);
  });
  it("at most 100", () => {
    expect(speechHints(Array.from({ length: 150 }, (_, i) => task(`Task number ${i}`, { tags: [`tag${i}`] })))).toHaveLength(MAX_SPEECH_HINTS);
  });
});
