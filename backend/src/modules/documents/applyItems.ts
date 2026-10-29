import { Priority, RoutineFrequency, RoutinePriority, TaskSource, TaskType } from "@prisma/client";
import { dueDateFromYmd, localYmd, parseClock } from "../../lib/time.js";
import { createRoutine } from "../routines/routineService.js";
import { createTask, serializeTask } from "../tasks/taskService.js";
import { existingRoutineId, existingTaskId } from "./documentProcessing.js";
import { docFlag, documentPriority } from "./routing.js";

export type ApplyDeadline = { title: string; date: string; time?: string | null };
export type ApplySchedule = { title: string; daysOfWeek: number[]; time?: string | null; durationMinutes?: number | null; location?: string | null };

/**
 * Creates the items the user confirmed from a document (the app's review screen, or "1" on WhatsApp). Items that
 * already exist are skipped, so confirming twice never duplicates. The route POST /documents/:id/apply and the
 * WhatsApp Agent's "add all" both call this.
 */
export async function applyDocumentItems(
  ctx: { userId: string; tz: string; deviceId: string | null },
  documentId: string,
  items: { deadlines: ApplyDeadline[]; schedules: ApplySchedule[] },
) {
  const { userId, tz } = ctx;
  const tasks = [];
  let skipped = 0;
  for (const d of items.deadlines) {
    const time = d.time && parseClock(d.time) ? d.time : "11:59 PM";
    if (await existingTaskId(userId, d.title, dueDateFromYmd(d.date, tz), time)) {
      skipped += 1;
      continue;
    }
    tasks.push(
      serializeTask(
        await createTask(
          { userId, tz, deviceId: ctx.deviceId },
          { title: d.title, priority: docFlag("DOC_PRIORITY_V2") ? documentPriority({ title: d.title, activity: "", date: d.date, source: "" }, localYmd(new Date(), tz)).priority : Priority.MEDIUM, category: "Academic", source: TaskSource.DOCUMENT, dueDate: dueDateFromYmd(d.date, tz), dueTime: time, taskType: TaskType.DEADLINE, documentId, confidence: 100 },
        ),
      ),
    );
  }
  const routines = [];
  for (const s of items.schedules) {
    if (await existingRoutineId(userId, s.title, s.daysOfWeek, s.time && parseClock(s.time) ? s.time : null, s.location)) {
      skipped += 1;
      continue;
    }
    routines.push(
      await createRoutine(userId, tz, {
        title: s.title,
        frequency: RoutineFrequency.WEEKLY,
        daysOfWeek: s.daysOfWeek,
        dueTime: s.time && parseClock(s.time) ? s.time : null,
        durationMinutes: s.durationMinutes ?? null,
        category: "Academic",
        priority: RoutinePriority.IMPORTANT,
        timeLocked: true,
        location: s.location ?? null,
      }),
    );
  }
  return { tasks, routines, skipped };
}
