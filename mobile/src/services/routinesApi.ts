import type { Routine, RoutineFrequency, RoutineOccurrence, RoutineOccurrenceStatus, RoutinePriority } from "../types/models";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "./api";
import { scheduleReminderSync } from "./reminders";

export type RoutineInput = {
  title: string;
  description?: string | null;
  frequency: RoutineFrequency;
  daysOfWeek?: number[] | null;
  dayOfMonth?: number | null;
  dueTime?: string | null;
  durationMinutes?: number | null;
  category?: string | null;
  priority: RoutinePriority;
  timeLocked: boolean;
  locationContext?: string | null;
};

export async function getRoutines(all = false): Promise<{ routines: Routine[]; context: string | null }> {
  return apiGet(`/routines${all ? "?all=true" : ""}`);
}

export async function getTodayOccurrences(): Promise<Array<RoutineOccurrence & { routine: Routine }>> {
  return (await apiGet<{ occurrences: Array<RoutineOccurrence & { routine: Routine }> }>("/routines/today")).occurrences;
}

export async function createRoutine(input: RoutineInput): Promise<Routine> {
  const { routine } = await apiPost<{ routine: Routine }>("/routines", input);
  scheduleReminderSync();
  return routine;
}

export async function updateRoutine(id: string, input: Partial<RoutineInput> & { active?: boolean }): Promise<Routine> {
  const { routine } = await apiPut<{ routine: Routine }>(`/routines/${id}`, input);
  scheduleReminderSync();
  return routine;
}

export async function deleteRoutine(id: string): Promise<void> {
  await apiDelete(`/routines/${id}`);
  scheduleReminderSync();
}

export async function updateRoutineOccurrence(id: string, status: RoutineOccurrenceStatus, confirmMandatory = false): Promise<void> {
  await apiPatch(`/routines/occurrences/${id}`, { status, confirmMandatory });
  scheduleReminderSync();
}

export async function rescheduleOccurrence(id: string, date: string, time: string | null): Promise<void> {
  await apiPost(`/routines/occurrences/${id}/reschedule`, { date, time });
  scheduleReminderSync();
}
