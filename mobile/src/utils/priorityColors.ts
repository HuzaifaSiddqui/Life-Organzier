import { palettes, type Palette } from "../theme/tokens";
import type { Priority } from "../types/models";

/**
 * FR-TM-003: red = urgent, orange = high, yellow = medium, blue = low — desaturated token hues.
 * Pass `useTheme().colors` from migrated screens; the light default serves unmigrated ones.
 * Always pair with the priority label: colour is never the only signal.
 */
export function priorityColor(priority: Priority, p: Palette = palettes.light): string {
  return p.priority[priority] ?? p.priority.LOW;
}

export function priorityPill(priority: Priority, p: Palette = palettes.light): { backgroundColor: string; color: string } {
  const color = priorityColor(priority, p);
  const bg = priority === "URGENT" ? p.danger.bg : priority === "HIGH" || priority === "MEDIUM" ? p.warning.bg : p.info.bg;
  return { backgroundColor: bg, color };
}

export const PRIORITY_RANK: Record<Priority, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/** Built-in categories → index into the curated `Palette.category` set. */
const CATEGORY_INDEX: Record<string, number> = { Work: 0, Personal: 1, Health: 2, Academic: 3, Finance: 6 };

export function categoryColor(name: string | null | undefined, custom: Array<{ name: string; color: string }> = [], p: Palette = palettes.light): string {
  if (!name) return p.textTertiary;
  const own = custom.find((c) => c.name === name)?.color;
  if (own) {
    // Custom categories store a light-palette hue; show its dark twin in dark mode.
    const i = palettes.light.category.indexOf(own);
    return i >= 0 ? p.category[i] : own;
  }
  const i = CATEGORY_INDEX[name];
  return i === undefined ? p.category[7] : p.category[i];
}
