import type { ParsedTask, Priority, Task } from "../types/models";
import { dueDateAndTimeForSave, validateDueDateNotPast, ymdFromLocalDate } from "../utils/datetimeValidation";
import { createTaskWithReminder, type CreateTaskReminderOptions } from "./createTaskWithReminder";
import type { ReminderResult } from "./reminders";

/**
 * Internal clarity threshold (uses parser `confidence` from the API — never shown in UI).
 * Above this → auto-create; at or below → show confirmation preview.
 */
export const CLARITY_INDEX_AUTO_CREATE_THRESHOLD = 90;

export function shouldAutoCreateFromClarityIndex(clarityIndex: number): boolean {
  return clarityIndex > CLARITY_INDEX_AUTO_CREATE_THRESHOLD;
}

export type ResolveDueFromParsedInput = {
  parsed: ParsedTask;
  manualDateYmd: string;
  manualTime: string;
  allDay: boolean;
};

/** Shared due encoding for chat + voice (same as manual task pipeline). */
export function resolveDueFromParsed(input: ResolveDueFromParsedInput): {
  dueDateIso: string | null;
  dueTime: string | null;
  error: string | null;
} {
  const { parsed, manualDateYmd, manualTime, allDay } = input;

  let dueTimeOut: string | null;
  if (allDay) {
    dueTimeOut = null;
  } else {
    const merged = `${manualTime.trim() || (parsed.dueTime ?? "")}`.trim();
    dueTimeOut = merged === "" ? null : merged;
  }

  const pickerYmd = manualDateYmd.trim() || parsed.dueDateYmd?.trim() || "";
  const { dueDateIso: dueDateOut, dueTime: dueTimeNormalized } = dueDateAndTimeForSave({
    pickerYmd: pickerYmd || undefined,
    parsedDueDateIso: pickerYmd ? null : parsed.dueDateIso,
    rawDueTime: dueTimeOut,
  });

  if (dueTimeNormalized && !dueDateOut) {
    return {
      dueDateIso: dueDateOut,
      dueTime: dueTimeNormalized,
      error:
        "Couldn't read that due time. Pick a due date, or phrase the time clearly (e.g. 3 PM).",
    };
  }

  const dateErr = validateDueDateNotPast(dueDateOut, dueTimeNormalized);
  if (dateErr) {
    return { dueDateIso: dueDateOut, dueTime: dueTimeNormalized, error: dateErr };
  }

  return { dueDateIso: dueDateOut, dueTime: dueTimeNormalized, error: null };
}

export type CreateFromParsedNaturalInput = {
  parsed: ParsedTask;
  title: string;
  manualDateYmd: string;
  manualTime: string;
  allDay: boolean;
  selectedPriority: Priority | null;
  reminderEnabled: boolean;
  source: "CHAT" | "VOICE";
  description: string | null;
};

export async function createTaskFromParsedNatural(
  input: CreateFromParsedNaturalInput,
): Promise<{ task: Task; reminder: ReminderResult }> {
  const title = input.title.trim();
  if (!title) {
    throw new Error("Please enter a task title.");
  }

  const priorityOut = input.selectedPriority ?? (input.parsed.priority as Priority);

  const { dueDateIso, dueTime, error } = resolveDueFromParsed({
    parsed: input.parsed,
    manualDateYmd: input.manualDateYmd,
    manualTime: input.manualTime,
    allDay: input.allDay,
  });
  if (error) {
    throw new Error(error);
  }

  const reminderOptions: CreateTaskReminderOptions = input.reminderEnabled
    ? { reminderEnabled: true, reminderHint: { dueDateIso, dueTime } }
    : { reminderEnabled: false };

  return createTaskWithReminder(
    {
      title,
      description: input.description ?? input.parsed.description ?? null,
      dueDate: dueDateIso,
      dueTime,
      priority: priorityOut,
      category: input.parsed.category,
      source: input.source,
      confidence: input.parsed.confidence,
    },
    reminderOptions,
  );
}

/** Seed preview fields from parser output (client calendar for ISO dates). */
export function initialPreviewFieldsFromParsed(parsed: ParsedTask): {
  titleDraft: string;
  manualDateYmd: string;
  manualTime: string;
} {
  return {
    titleDraft: parsed.title,
    manualDateYmd:
      parsed.dueDateYmd?.trim() ||
      (parsed.dueDateIso ? ymdFromLocalDate(new Date(parsed.dueDateIso)) : ""),
    manualTime: parsed.dueTime?.trim() ?? "",
  };
}

export function formatTaskCreatedToast(reminder: ReminderResult): string {
  const headline = "Task created successfully.";
  if (reminder.kind === "scheduled") {
    return `${headline} Reminder set for ${reminder.when.toLocaleString()}.`;
  }
  if (reminder.kind === "cleared") {
    return headline;
  }
  if (reminder.reason === "past_due") {
    return `${headline} No reminder — that time is already in the past.`;
  }
  if (reminder.reason === "permission_denied") {
    return `${headline} No reminder — turn on notifications to get reminders.`;
  }
  if (reminder.reason === "schedule_failed") {
    return `${headline} Reminder could not be scheduled on this device.`;
  }
  return `${headline} No reminder scheduled (add a future due date and time to get one).`;
}
