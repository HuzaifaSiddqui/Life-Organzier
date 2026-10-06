import type { Priority } from "../types/models";

/** FR-TM-003: red = urgent, orange = high, yellow = medium, blue = low. */
export function priorityColor(priority: Priority): string {
  switch (priority) {
    case "URGENT":
      return "#DC2626";
    case "HIGH":
      return "#EA580C";
    case "MEDIUM":
      return "#CA8A04";
    case "LOW":
    default:
      return "#2563EB";
  }
}

export function priorityPill(priority: Priority): { backgroundColor: string; color: string } {
  switch (priority) {
    case "URGENT":
      return { backgroundColor: "#FEF2F2", color: "#DC2626" };
    case "HIGH":
      return { backgroundColor: "#FFF7ED", color: "#EA580C" };
    case "MEDIUM":
      return { backgroundColor: "#FEFCE8", color: "#A16207" };
    case "LOW":
    default:
      return { backgroundColor: "#EFF6FF", color: "#2563EB" };
  }
}

export const PRIORITY_RANK: Record<Priority, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

const CATEGORY_COLORS: Record<string, string> = {
  Work: "#2563EB",
  Personal: "#9333EA",
  Health: "#16A34A",
  Academic: "#EA580C",
  Finance: "#CA8A04",
};

export function categoryColor(name: string | null | undefined, custom: Array<{ name: string; color: string }> = []): string {
  if (!name) return "#94A3B8";
  return custom.find((c) => c.name === name)?.color ?? CATEGORY_COLORS[name] ?? "#64748B";
}
