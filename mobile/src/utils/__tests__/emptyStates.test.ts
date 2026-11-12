import { describe, expect, it } from "vitest";
import { tasksEmpty } from "../emptyStates";

const base = { query: "", filters: 0, range: "ALL" as const, status: "ALL" };

describe("empty task list: message and next action", () => {
  it("a search wins: clear it", () => {
    expect(tasksEmpty({ ...base, query: "bank", filters: 2, range: "TOMORROW" }).actions).toEqual(["clearSearch"]);
  });
  it("filters or a status: clear them", () => {
    expect(tasksEmpty({ ...base, filters: 1 }).actions).toEqual(["clearFilters"]);
    expect(tasksEmpty({ ...base, status: "OVERDUE" }).title).toBe("empty.tasks.filterTitle");
  });
  it("today: add a task or plan the day; tomorrow: add one or ask the assistant", () => {
    expect(tasksEmpty({ ...base, range: "TODAY" }).actions).toEqual(["addTask", "planDay"]);
    expect(tasksEmpty({ ...base, range: "TOMORROW" })).toEqual({ title: "empty.tasks.tomorrowTitle", text: "empty.tasks.tomorrowText", actions: ["addTask", "askAssistant"] });
  });
  it("no tasks at all: add one or ask the assistant", () => {
    expect(tasksEmpty(base).actions).toEqual(["addTask", "askAssistant"]);
  });
});
