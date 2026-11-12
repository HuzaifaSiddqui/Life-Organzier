import type { RangeFilter } from "./taskRange";

/**
 * UI v2: what an empty task list says and which next actions it offers, from why it is empty. The most specific
 * reason wins: a search, then filters, then the range (Today / Tomorrow), else no tasks at all.
 */
export type EmptyAction = "clearSearch" | "clearFilters" | "addTask" | "planDay" | "askAssistant";

export function tasksEmpty(s: { query: string; filters: number; range: RangeFilter; status: string }): { title: string; text: string; actions: EmptyAction[] } {
  if (s.query.trim()) return { title: "empty.tasks.searchTitle", text: "empty.tasks.searchText", actions: ["clearSearch"] };
  if (s.filters || s.status !== "ALL") return { title: "empty.tasks.filterTitle", text: "empty.tasks.filterText", actions: ["clearFilters"] };
  if (s.range === "TODAY") return { title: "empty.tasks.todayTitle", text: "empty.tasks.todayText", actions: ["addTask", "planDay"] };
  if (s.range === "TOMORROW") return { title: "empty.tasks.tomorrowTitle", text: "empty.tasks.tomorrowText", actions: ["addTask", "askAssistant"] };
  return { title: "empty.tasks.noneTitle", text: "empty.tasks.noneText", actions: ["addTask", "askAssistant"] };
}
