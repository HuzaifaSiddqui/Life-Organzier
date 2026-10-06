import type { NextFunction, Response } from "express";
import type { User, UserSettings } from "@prisma/client";
import { ZodError, type ZodTypeAny, type z } from "zod";
import { prisma } from "../config/db.js";
import type { AuthRequest } from "../middleware/authMiddleware.js";
import { sendError } from "../utils/apiResponse.js";
import { isValidTimeZone } from "./time.js";

export type UserRequest = AuthRequest & {
  user: User;
  settings: UserSettings;
  deviceId: string | null;
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function parseBody<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, "VALIDATION_ERROR", issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid request");
  }
  return parsed.data;
}

let onTimezoneChanged: ((userId: string, tz: string) => void) | null = null;

/** Registered by the task module so deadlines are recomputed when the device timezone changes. */
export function setTimezoneChangeHandler(fn: (userId: string, tz: string) => void): void {
  onTimezoneChanged = fn;
}

export async function ensureSettings(userId: string): Promise<UserSettings> {
  return prisma.userSettings.upsert({ where: { userId }, create: { userId }, update: {} });
}

/**
 * Loads the database user + settings for an authenticated Firebase request and keeps the
 * user's timezone in sync with the device (X-Timezone header).
 */
export async function requireUser(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const uid = req.firebase?.uid;
  if (!uid) {
    sendError(res, "Unauthorized", "UNAUTHORIZED", 401);
    return;
  }
  try {
    const user = await prisma.user.findUnique({ where: { firebaseUid: uid } });
    if (!user) {
      sendError(res, "User not found. Call sync-user first.", "USER_NOT_FOUND", 404);
      return;
    }
    let settings = await ensureSettings(user.id);
    const tzHeader = req.header("x-timezone");
    if (tzHeader && isValidTimeZone(tzHeader) && tzHeader !== settings.timezone) {
      settings = await prisma.userSettings.update({ where: { userId: user.id }, data: { timezone: tzHeader } });
      onTimezoneChanged?.(user.id, tzHeader);
    }
    const r = req as UserRequest;
    r.user = user;
    r.settings = settings;
    r.deviceId = req.header("x-device-id")?.slice(0, 120) ?? null;
    next();
  } catch (error) {
    console.error("Could not load database user", error);
    sendError(res, "Database is temporarily unavailable", "DATABASE_UNAVAILABLE", 503);
  }
}

/** Wraps an async handler so thrown errors become consistent JSON responses. */
export function handle(fn: (req: UserRequest, res: Response) => Promise<void>) {
  return async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      await fn(req as UserRequest, res);
    } catch (error) {
      if (error instanceof HttpError) {
        sendError(res, error.message, error.code, error.status);
        return;
      }
      if (error instanceof ZodError) {
        sendError(res, "Invalid request", "VALIDATION_ERROR", 400);
        return;
      }
      console.error(`Request failed: ${req.method} ${req.originalUrl}`, error);
      if (!res.headersSent) sendError(res, "Something went wrong. Please try again.", "INTERNAL_ERROR", 500);
    }
  };
}
