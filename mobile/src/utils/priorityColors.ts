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

/** Pill styles aligned with Life Organizer UI prototype */
export function priorityPill(priority: Priority): { backgroundColor: string; color: string } {
  switch (priority) {
    case "URGENT":
    case "HIGH":
      return { backgroundColor: "#FEF2F2", color: "#DC2626" };
    case "MEDIUM":
      return { backgroundColor: "#EEF7FF", color: "#1D99FF" };
    case "LOW":
    default:
      return { backgroundColor: "#F0FDF4", color: "#16A34A" };
  }
}
