import type { Priority } from "../types/models";

export function priorityColor(priority: Priority): string {
  switch (priority) {
    case "URGENT":
      return "#dc2626";
    case "HIGH":
      return "#ea580c";
    case "MEDIUM":
      return "#ca8a04";
    case "LOW":
    default:
      return "#64748b";
  }
}
