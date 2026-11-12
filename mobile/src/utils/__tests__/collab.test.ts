import { describe, expect, it } from "vitest";
import { activeMention, cleanUsername, collabErrorKey, doneCount, filterPeople, personLabel, searchable, withoutActiveMention, noticeTarget, badgeText, validReason, insertMention, DECLINE_REASON_MAX } from "../collab";

const people = [
  { id: "1", username: "ali_khan", displayName: "Ali Khan" },
  { id: "2", username: "sana", displayName: "Sana Zaidi" },
  { id: "3", username: null, displayName: "Bilal Ahmed" },
];

describe("task collaboration helpers", () => {
  it("the mention being typed: after an @ that starts a word, up to the end", () => {
    expect(activeMention("@")).toBe("");
    expect(activeMention("Report for @Al")).toBe("al");
    expect(activeMention("mail a@b")).toBeNull();
    expect(activeMention("@ali done")).toBeNull();
    expect(activeMention("no mention")).toBeNull();
  });

  it("picking a person removes what was typed for them", () => {
    expect(withoutActiveMention("@al")).toBe("");
    expect(withoutActiveMention("with @al")).toBe("with ");
  });

  it("filters connections by username or any word of the name; picked ones left out", () => {
    expect(filterPeople(people, "").map((p) => p.id)).toEqual(["1", "2", "3"]);
    expect(filterPeople(people, "a").map((p) => p.id)).toEqual(["1", "3"]);
    expect(filterPeople(people, "zai").map((p) => p.id)).toEqual(["2"]);
    expect(filterPeople(people, "@s").map((p) => p.id)).toEqual(["2"]);
    expect(filterPeople(people, "a", ["1"]).map((p) => p.id)).toEqual(["3"]);
  });

  it("labels, usernames, counts and error copy", () => {
    expect(personLabel(people[0])).toBe("@ali_khan");
    expect(personLabel(people[2])).toBe("Bilal Ahmed");
    expect(personLabel(null)).toBe("Someone");
    expect(cleanUsername(" @Ali_Khan")).toBe("ali_khan");
    expect(cleanUsername("ab")).toBeNull();
    expect(cleanUsername("ali khan")).toBeNull();
    expect(doneCount(["done", "accepted", "declined", "done"])).toEqual({ done: 2, total: 3 });
    expect(collabErrorKey("USERNAME_TAKEN", false)).toBe("collab.err.USERNAME_TAKEN");
    expect(collabErrorKey("WHATEVER", false)).toBe("collab.err.generic");
    expect(collabErrorKey(null, true)).toBe("collab.err.offline");
    expect(collabErrorKey("RATE_LIMITED", false)).toBe("collab.err.RATE_LIMITED");
  });

  it("search runs only for a username prefix of 3+ or a whole email (as the server)", () => {
    expect(searchable("a")).toBe(false);
    expect(searchable("al")).toBe(false);
    expect(searchable("ali")).toBe(true);
    expect(searchable("@ali_k")).toBe(true);
    expect(searchable("ali khan")).toBe(false);
    expect(searchable("ali.khan@gm")).toBe(false);
    expect(searchable(" Ali.Khan@Gmail.com ")).toBe(true);
  });

  it("where a notice or its push opens: the card to answer, my copy, People, or Shared", () => {
    expect(noticeTarget({ kind: "TASK_INVITE", sharedTaskId: "s1", pending: true })).toEqual({ screen: "SharedTaskEdit", params: { id: "s1", mode: "accept" } });
    expect(noticeTarget({ kind: "TASK_PROGRESS", sharedTaskId: "s1", taskId: "t1" })).toEqual({ screen: "TaskDetail", params: { taskId: "t1" } });
    expect(noticeTarget({ kind: "TASK_REJECTED", sharedTaskId: "s1", taskId: null })).toEqual({ screen: "Collab", params: { tab: "shared" } });
    expect(noticeTarget({ kind: "CONNECTION_REQUEST", sharedTaskId: null })).toEqual({ screen: "Collab", params: { tab: "requests" } });
    expect(noticeTarget({ kind: "TASK_INVITE", sharedTaskId: "s1" })).toEqual({ screen: "SharedTaskEdit", params: { id: "s1", mode: "accept" } });
  });

  it("badge text, decline reasons, inserting a mention", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(3)).toBe("3");
    expect(badgeText(12)).toBe("9+");
    expect(validReason("  ")).toBe(false);
    expect(validReason("Too busy")).toBe(true);
    expect(validReason("x".repeat(DECLINE_REASON_MAX + 1))).toBe(false);
    expect(insertMention("Finish slides with @al", { id: "1", username: "ali_khan", displayName: "Ali Khan" })).toBe("Finish slides with @ali_khan ");
    expect(insertMention("@", { id: "2", username: null, displayName: "Sana Zaidi" })).toBe("Sana Zaidi ");
  });
});
