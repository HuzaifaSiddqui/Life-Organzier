import { Router } from "express";
import { z } from "zod";
import { handle, parseBody, requireUser } from "../../lib/http.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendSuccess } from "../../utils/apiResponse.js";
import { logEvent } from "../events/eventService.js";
import { planReminders, recordReminderAction } from "./reminderService.js";

export const reminderRouter = Router();
reminderRouter.use(requireFirebaseUser, requireUser);

/** Reminder plan the device schedules as local OS notifications (offline-first, FR-RN-002). */
reminderRouter.get(
  "/plan",
  handle(async (req, res) => {
    const days = Math.min(14, Math.max(1, Number(req.query.days ?? 7)));
    const reminders = await planReminders(req.user.id, req.settings, new Date(), days);
    sendSuccess(res, {
      reminders,
      settings: {
        method: req.settings.notificationMethod,
        devices: req.settings.notificationDevices,
        dndUntil: req.settings.dndUntil,
        frequency: req.settings.notificationFrequency,
      },
      generatedAt: new Date().toISOString(),
    });
  }),
);

reminderRouter.post(
  "/action",
  handle(async (req, res) => {
    const body = parseBody(
      z.object({
        taskId: z.string().uuid().nullable().optional(),
        fireAt: z.string().nullable().optional(),
        action: z.enum(["DONE", "SNOOZE", "OPEN", "DISMISS"]),
      }),
      req.body,
    );
    if (body.taskId) {
      await recordReminderAction(req.user.id, body.taskId, body.fireAt && !Number.isNaN(Date.parse(body.fireAt)) ? new Date(body.fireAt) : null, body.action);
    }
    logEvent(req.user.id, "REMINDER_ACTION", body.taskId ?? null, { action: body.action });
    sendSuccess(res, {}, "Recorded");
  }),
);
