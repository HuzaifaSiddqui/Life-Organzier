import { describe, expect, it } from "vitest";
import type { Task } from "../../types/models";
import { MAX_SPEECH_HINTS, speechHints } from "../speechHints";

const task = (title: string, o: Partial<Task> = {}) => ({ id: title, title, status: "PENDING", tags: [], locations: [], ...o }) as unknown as Task;

describe("speechHints", () => {
  it("places, course codes and tags first, then open task titles; no repeats; done tasks left out", () => {
    const hints = speechHints([
      task("Eat burger", { locations: [{ name: "KFC" }] as Task["locations"] }),
      task("CSC461 assignment 3", { tags: ["fyp"] }),
      task("Old thing", { status: "COMPLETED", locations: [{ name: "Old Place" }] as Task["locations"] }),
      task("eat burger"),
    ]);
    expect(hints).toEqual(["KFC", "CSC461", "fyp", "Eat burger", "CSC461 assignment 3"]);
  });
  it("at most 100", () => {
    expect(speechHints(Array.from({ length: 150 }, (_, i) => task(`Task number ${i}`)))).toHaveLength(MAX_SPEECH_HINTS);
  });
});
