import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { Task } from "../types/models";
import { computeReminderTriggerAt, effectiveDueDateIso } from "../utils/datetimeValidation";

const REMINDER_MAP_KEY = "taskReminderMap:v1";

type ReminderMap = Record<string, string>;

export type ReminderResult =
  | { kind: "scheduled"; when: Date }
  | { kind: "cleared" }
  | {
      kind: "skipped";
      reason: "no_due_date" | "past_due" | "permission_denied" | "schedule_failed";
    };

let configured = false;

function trimToNull(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
}

function notificationBody(title: string | null | undefined): string {
  const t = String(title ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length === 0) return "Your task";
  return t.slice(0, 500);
}

async function readReminderMap(): Promise<ReminderMap> {
  const raw = await AsyncStorage.getItem(REMINDER_MAP_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ReminderMap;
  } catch {
    return {};
  }
}

async function writeReminderMap(map: ReminderMap): Promise<void> {
  await AsyncStorage.setItem(REMINDER_MAP_KEY, JSON.stringify(map));
}

async function clearExistingReminder(taskId: string): Promise<void> {
  const map = await readReminderMap();
  const existingId = map[taskId];
  if (existingId) {
    await Notifications.cancelScheduledNotificationAsync(existingId);
    delete map[taskId];
    await writeReminderMap(map);
  }
}

async function ensureNotificationPermissions(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;

  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

export async function configureReminders(): Promise<void> {
  if (configured) return;
  configured = true;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("task-reminders", {
      name: "Task Reminders",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 200, 250],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      sound: "default",
      enableVibrate: true,
    });
  }
}

/** Exact due fields used when saving/updating — same snapshot manual Add Task sends to POST /tasks. */
export type TaskReminderHint = {
  dueDateIso: string | null;
  dueTime: string | null;
};

function mergeDuePartsFromTask(task: Task, hint?: TaskReminderHint): {
  dueDateIso: string | null;
  dueTime: string | null;
} {
  if (hint) {
    return {
      dueDateIso: trimToNull(hint.dueDateIso),
      dueTime: trimToNull(hint.dueTime),
    };
  }
  return {
    dueDateIso: trimToNull(task.dueDate),
    dueTime: trimToNull(task.dueTime),
  };
}

export async function upsertTaskReminder(task: Task, hint?: TaskReminderHint): Promise<ReminderResult> {
  await configureReminders();

  if (task.status === "COMPLETED" || task.status === "DELETED") {
    await clearExistingReminder(task.id);
    return task.dueDate ? { kind: "cleared" } : { kind: "skipped", reason: "no_due_date" };
  }

  const merged = mergeDuePartsFromTask(task, hint);

  // effectiveDueDateIso() rewrites any dueDate string to the same local-midnight ISO shape as manual Add Task
  const resolvedDueDate = effectiveDueDateIso(merged.dueDateIso, merged.dueTime);
  if (!resolvedDueDate) {
    await clearExistingReminder(task.id);
    return { kind: "skipped", reason: "no_due_date" };
  }

  const granted = await ensureNotificationPermissions();
  if (!granted) {
    return { kind: "skipped", reason: "permission_denied" };
  }

  const triggerAt = computeReminderTriggerAt(resolvedDueDate, merged.dueTime);
  if (!triggerAt || triggerAt.getTime() <= Date.now()) {
    await clearExistingReminder(task.id);
    return { kind: "skipped", reason: "past_due" };
  }

  await clearExistingReminder(task.id);
  const trigger: Notifications.NotificationTriggerInput =
    Platform.OS === "android"
      ? {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: triggerAt,
          channelId: "task-reminders",
        }
      : {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: triggerAt,
        };

  try {
    const content: Notifications.NotificationContentInput = {
      title: "Task reminder",
      body: notificationBody(task.title),
      sound: true,
      data: { taskId: task.id, kind: "task_reminder" },
    };
    if (Platform.OS === "android") {
      content.priority = Notifications.AndroidNotificationPriority.MAX;
    }

    const notificationId = await Notifications.scheduleNotificationAsync({
      identifier: `task-reminder:${task.id}`,
      content,
      trigger,
    });

    const map = await readReminderMap();
    map[task.id] = notificationId;
    await writeReminderMap(map);
    return { kind: "scheduled", when: triggerAt };
  } catch (e) {
    console.warn("scheduleNotificationAsync failed", e);
    return { kind: "skipped", reason: "schedule_failed" };
  }
}

export async function clearTaskReminder(taskId: string): Promise<void> {
  await configureReminders();
  await clearExistingReminder(taskId);
}

export function reminderFeedbackText(result: ReminderResult): string {
  if (result.kind === "scheduled") {
    return `Reminder set for ${result.when.toLocaleString()}`;
  }
  if (result.kind === "cleared") {
    return "Reminder cleared";
  }
  if (result.reason === "past_due") {
    return "Reminder not set because due time is in the past";
  }
  if (result.reason === "permission_denied") {
    return "Reminder not set because notification permission is denied";
  }
  if (result.reason === "schedule_failed") {
    return "Reminder not set (OS could not schedule notification — try reinstalling app or freeing storage)";
  }
  return "Reminder skipped (no due date)";
}
