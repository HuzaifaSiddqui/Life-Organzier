import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db.js";

/** Interaction log used for pattern learning and analytics (FR-PL-001, FR-AN-001). */
export type ActivityType =
  | "APP_OPEN"
  | "TASK_CREATED"
  | "CHECKIN_RESPONSE"
  | "CHECKIN_STYLE_CHANGED"
  | "ESTIMATE_SUGGESTION_SHOWN"
  | "ESTIMATE_SUGGESTION_ACCEPTED"
  | "TASK_COMPLETED"
  | "TASK_UPDATED"
  | "TASK_DELETED"
  | "TASK_SKIPPED"
  | "TASK_POSTPONED"
  | "ROUTINE_COMPLETED"
  | "ROUTINE_SKIPPED"
  | "ROUTINE_MISSED"
  | "MOOD_LOGGED"
  | "REMINDER_ACTION"
  | "RECOMMENDATION_ACCEPTED"
  | "RECOMMENDATION_REJECTED"
  | "CONTEXT_SWITCHED"
  | "WHATSAPP_SENT"
  | "WHATSAPP_RECEIVED";

export function logEvent(
  userId: string,
  type: ActivityType,
  entityId?: string | null,
  payload?: Prisma.InputJsonValue,
): void {
  prisma.activityEvent
    .create({ data: { userId, type, entityId: entityId ?? null, payload: payload ?? Prisma.JsonNull } })
    .catch((error) => console.warn("Could not log activity event", error instanceof Error ? error.message : error));
}

export async function logEventAwait(
  userId: string,
  type: ActivityType,
  entityId?: string | null,
  payload?: Prisma.InputJsonValue,
): Promise<void> {
  await prisma.activityEvent.create({ data: { userId, type, entityId: entityId ?? null, payload: payload ?? Prisma.JsonNull } });
}
