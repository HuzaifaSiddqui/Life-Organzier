import { prisma } from "../../config/db.js";

/**
 * Cancels a task's still-scheduled check-ins. With `keepSlot`, only rows planned for a different
 * scheduledStart are cancelled (the task was rescheduled); without it, all (task done/deleted).
 * Cancelled rows are kept for the evaluation; the phone drops their notifications on the next plan sync.
 */
export async function cancelCheckins(taskId: string, keepSlot?: Date | null): Promise<number> {
  const r = await prisma.checkinLog.updateMany({
    where: { taskId, status: "SCHEDULED", ...(keepSlot ? { NOT: { slotStart: keepSlot } } : {}) },
    data: { status: "CANCELLED" },
  });
  return r.count;
}
