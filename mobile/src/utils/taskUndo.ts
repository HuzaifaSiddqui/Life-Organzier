import type { Task, TaskStatus } from "../types/models";

/**
 * Swipe Undo (UI v2): what to send to put a task back exactly as it was before the swipe. Status alone isn't
 * enough: reopening a done task without a progress makes the server keep min(progress, 75), so Undo of a
 * "Done" swipe left a never-started task at 75 %. Sending the old progress too restores it exactly; the calendar
 * mark ("✓ ") follows the status on the next calendar sync.
 */
export function undoStatusChanges(prev: Pick<Task, "status" | "progress">): { status: TaskStatus; progress: number } {
  return { status: prev.status, progress: prev.progress ?? 0 };
}

/**
 * The status / progress rules the phone applies locally before the server answers (tasksApi.updateTask): done
 * means 100 %, and 100 % means done. Shared so the local copy and the Undo test use the same rule.
 */
export function mergeStatusProgress(
  existing: Pick<Task, "status" | "progress">,
  changes: { status?: TaskStatus; progress?: number },
): { status: TaskStatus; progress: number } {
  return {
    progress: changes.status === "COMPLETED" ? 100 : (changes.progress ?? existing.progress ?? 0),
    status: changes.progress === 100 ? "COMPLETED" : (changes.status ?? existing.status),
  };
}
