import { formatDuration } from "./format";

/**
 * Task form (UI v2): the line under a collapsed "More options" — every collapsed field that has a value, so nothing
 * set is hidden. Empty when none is set (the hint is shown instead).
 */
export type MoreValues = {
  description: string;
  category: string | null;
  tags: string[];
  durationMinutes: number | null;
  difficulty: number | null;
  locationContext: string | null;
  reminderMode: string;
  reminderMinutes: number | null;
  status: string;
};

const DIFFICULTY = ["Easy", "Light", "Medium", "Hard", "Very hard"];
const REMINDER: Record<string, string> = { ESCALATING: "Escalating reminders", MULTIPLE: "A few reminders", SINGLE: "One reminder", NONE: "No reminders" };

export function moreSummary(v: MoreValues, opts: { editing?: boolean; places?: number } = {}): string[] {
  const out: string[] = [];
  if (v.description.trim()) out.push("Notes");
  if (v.category) out.push(v.category);
  if (v.tags.length) out.push(v.tags.slice(0, 3).map((t) => `#${t}`).join(" ") + (v.tags.length > 3 ? ` +${v.tags.length - 3}` : ""));
  if (v.durationMinutes) out.push(formatDuration(v.durationMinutes));
  if (v.difficulty) out.push(DIFFICULTY[v.difficulty - 1] ?? "");
  if (v.locationContext) out.push(v.locationContext);
  if (REMINDER[v.reminderMode]) out.push(REMINDER[v.reminderMode]);
  if (v.reminderMinutes === 60) out.push("1 h before");
  if (v.reminderMinutes === 1440) out.push("1 day before");
  if (opts.places) out.push(opts.places === 1 ? "1 place" : `${opts.places} places`);
  if (opts.editing && v.status !== "PENDING") out.push(v.status === "IN_PROGRESS" ? "In progress" : v.status === "COMPLETED" ? "Completed" : v.status);
  return out.filter(Boolean);
}
