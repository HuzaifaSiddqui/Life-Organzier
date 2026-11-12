import type { Briefing } from "../types/models";

/**
 * Home (UI v2): pure rules for the summary line, the "then: …" line under Next up and the quick-access tile captions.
 * Everything comes from the briefing Home already loads; no extra requests. Each returns a string key + values for
 * t(), or null when there is nothing to show (the tile then shows its plain label).
 */

type Copy = { key: string; vars?: Record<string, string> };

/** "3 due today · 1 overdue · 2 done": overdue only when there is any. */
export function summaryParts(stats: Briefing["stats"]): Copy[] {
  const out: Copy[] = [{ key: "home.summary.due", vars: { count: String(stats.dueToday) } }];
  if (stats.overdue) out.push({ key: "home.summary.overdue", vars: { count: String(stats.overdue) } });
  out.push({ key: "home.summary.done", vars: { count: String(stats.completedToday) } });
  return out;
}

/**
 * What comes after Next up today: the first open task in today's list that isn't Next up, else the first pending
 * routine with a time. null: nothing else today.
 */
export function thenUp(b: Pick<Briefing, "nextUp" | "today">): { title: string; time: string | null } | null {
  const task = b.today.tasks.find((t) => t.id !== b.nextUp?.id && t.status !== "COMPLETED" && t.status !== "SKIPPED" && t.status !== "DELETED");
  if (task) return { title: task.title, time: task.dueTime ?? null };
  const routine = b.today.routines.find((r) => r.status === "PENDING" && r.time);
  return routine ? { title: routine.title, time: routine.time } : null;
}

/** Routines tile: "2 left today", "All done today", or null (no routines today: plain label). */
export function routinesCaption(routines: Briefing["today"]["routines"]): Copy | null {
  if (!routines.length) return null;
  const left = routines.filter((r) => r.status === "PENDING").length;
  return left ? { key: "home.tiles.routinesLeft", vars: { count: String(left) } } : { key: "home.tiles.routinesDone" };
}

/** Mood tile: "Check in" while one is due (or nothing logged yet), else the latest mood. */
export function moodCaption(mood: Briefing["mood"]): Copy {
  if (mood.checkinDue || !mood.latest) return { key: "home.tiles.moodCheckin" };
  return { key: "home.tiles.moodLatest", vars: { mood: mood.latest.mood } };
}
