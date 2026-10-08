import { Priority, ReminderMode, TaskStatus, TaskType, type Task, type UserSettings } from "@prisma/client";
import { prisma } from "../src/config/db.js";

/** Shared test fixtures (no database). */
export const TZ = "Asia/Karachi";
// Monday 2026-10-05 10:00 in Karachi (UTC+5)
export const NOW = new Date("2026-10-05T05:00:00.000Z");
export const opts = { now: NOW, tz: TZ, contexts: ["At Home", "At Work", "At University"] };

export function settings(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    userId: "u1",
    timezone: TZ,
    language: "en",
    quietStart: "22:00",
    quietEnd: "08:00",
    workStart: "08:00",
    workEnd: "22:00",
    dailyCapacityMinutes: 480,
    notificationFrequency: "ADAPTIVE",
    notificationMethod: "SOUND_VIBRATION",
    notificationDevices: "ALL",
    criticalOverridesDnd: true,
    dndUntil: null,
    currentContext: null,
    contexts: [],
    tier: "FREE",
    onboardingCompleted: true,
    tutorialsEnabled: true,
    tutorialsSeen: [],
    dismissedInsights: [],
    ttsEnabled: false,
    ttsRate: 1,
    lastWhatsappMessageAt: null,
    checkinsEnabled: true,
    checkinTone: "FUNNY",
    checkinResearchMode: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    userId: "u1",
    title: "Assignment",
    description: null,
    dueDate: null,
    dueTime: null,
    dueAt: null,
    priority: Priority.MEDIUM,
    category: null,
    status: TaskStatus.PENDING,
    source: "CHAT",
    confidence: null,
    createdAt: NOW,
    updatedAt: NOW,
    parentTaskId: null,
    progress: 0,
    durationMinutes: null,
    difficulty: null,
    taskType: TaskType.DEADLINE,
    archived: false,
    deletedAt: null,
    completedAt: null,
    scheduledStart: null,
    scheduledEnd: null,
    tags: null,
    locationContext: null,
    reminderMinutes: null,
    reminderMode: ReminderMode.ADAPTIVE,
    version: 1,
    deviceId: null,
    lastModifiedAt: NOW,
    clientId: null,
    documentId: null,
    startedAt: null,
    checkinCopy: null,
    ...overrides,
  };
}

/**
 * DB-backed tests run when a database is reachable and skip otherwise (local runs without
 * DATABASE_URL). CI sets REQUIRE_DB=true, which turns a missing database into a failure.
 */
export const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
if (process.env.REQUIRE_DB === "true" && !dbAvailable) throw new Error("REQUIRE_DB=true but the database is not reachable");
