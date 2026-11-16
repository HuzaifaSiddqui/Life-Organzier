import { describe, expect, it } from "vitest";
import { addOp, failureAction, MAX_ATTEMPTS, type OutboxOp } from "../outbox";

const op = (id: string, extra: Partial<OutboxOp> = {}): OutboxOp => ({ id, method: "PUT", path: "/x", at: 0, ...extra });

describe("outbox queue", () => {
  it("keeps unrelated changes in order", () => {
    const q = addOp(addOp([], op("a")), op("b"));
    expect(q.map((o) => o.id)).toEqual(["a", "b"]);
  });

  it("a newer change to the same thing replaces the older one and moves to the end", () => {
    let q = addOp([], op("done", { key: "occurrence:1", body: { status: "COMPLETED" } }));
    q = addOp(q, op("other"));
    q = addOp(q, op("skip", { key: "occurrence:1", body: { status: "SKIPPED" } }));
    expect(q.map((o) => o.id)).toEqual(["other", "skip"]);
    expect(q[1].body).toEqual({ status: "SKIPPED" });
  });

  it("merging combines two settings changes into one request", () => {
    let q = addOp([], op("1", { key: "settings", merge: true, body: { language: "ur", ttsRate: 1 } }));
    q = addOp(q, op("2", { key: "settings", merge: true, body: { ttsRate: 1.5 } }));
    expect(q).toHaveLength(1);
    expect(q[0].body).toEqual({ language: "ur", ttsRate: 1.5 });
  });
});

describe("outbox failures", () => {
  it("offline, timeouts and rate limits are tried again", () => {
    expect(failureAction(null, 0)).toBe("retry");
    expect(failureAction(408, 0)).toBe("retry");
    expect(failureAction(429, 3)).toBe("retry");
  });

  it("the server refusing a change drops it (the screen undoes it)", () => {
    expect(failureAction(400, 0)).toBe("drop");
    expect(failureAction(403, 0)).toBe("drop");
    expect(failureAction(404, 0)).toBe("drop");
  });

  it("server errors are retried a few times, then given up so they can't block the queue", () => {
    expect(failureAction(500, 0)).toBe("retry");
    expect(failureAction(503, MAX_ATTEMPTS - 2)).toBe("retry");
    expect(failureAction(503, MAX_ATTEMPTS - 1)).toBe("drop");
  });
});
