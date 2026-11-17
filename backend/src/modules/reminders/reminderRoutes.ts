import { Router } from "express";
import { z } from "zod";
import { handle, parseBody, requireUser } from "../../lib/http.js";
import { prisma } from "../../config/db.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendSuccess } from "../../utils/apiResponse.js";
import { logEvent } from "../events/eventService.js";
import { planCheckins } from "../checkins/checkinService.js";
import { remindersViaAgent } from "../whatsappAgent/service.js";
import { pendingRoutineOccurrenceIds, planReminders, recordReminderAction } from "./reminderService.js";

export const reminderRouter = Router();
reminderRouter.use(requireFirebaseUser, requireUser);

/** Reminder plan the device schedules as local OS notifications (offline-first, FR-RN-002). */
reminderRouter.get(
  "/plan",
  handle(async (req, res) => {
    const days = Math.min(14, Math.max(1, Number(req.query.days ?? 7)));
    // This phone now has every reminder as of now (push/missedReminders.ts sends only what changed after this).
    if (req.deviceId) await prisma.pushToken.updateMany({ where: { userId: req.user.id, deviceId: req.deviceId }, data: { planSyncedAt: new Date() } });
    const reminders = await planReminders(req.user.id, req.settings, new Date(), days);
    // FR-RN-004: separate list; the phone schedules reminders first, then check-ins, within its cap.
    const checkins = await planCheckins(req.user.id, req.settings, new Date(), days);
    sendSuccess(res, {
      reminders,
      checkins,
      // A snoozed routine alarm comes back on the phone only while its occurrence is still pending.
      pendingOccurrences: await pendingRoutineOccurrenceIds(req.user.id, new Date()),
      settings: {
        method: req.settings.notificationMethod,
        devices: req.settings.notificationDevices,
        dndUntil: req.settings.dndUntil,
        frequency: req.settings.notificationFrequency,
        // WhatsApp Agent reminders instead of phone notifications: the phone leaves task and routine reminders out.
        viaWhatsappAgent: await remindersViaAgent(req.user.id),
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
