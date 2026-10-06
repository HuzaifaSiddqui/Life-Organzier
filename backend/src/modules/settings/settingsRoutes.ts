import { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db.js";
import { handle, HttpError, parseBody, requireUser } from "../../lib/http.js";
import { isValidTimeZone, parseClock } from "../../lib/time.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendSuccess } from "../../utils/apiResponse.js";
import { logEvent } from "../events/eventService.js";
import { knownTags, recomputeDueAts, removeTagEverywhere } from "../tasks/taskService.js";

export const PREDEFINED_CATEGORIES = [
  { name: "Work", color: "#2563EB" },
  { name: "Personal", color: "#9333EA" },
  { name: "Health", color: "#16A34A" },
  { name: "Academic", color: "#EA580C" },
  { name: "Finance", color: "#CA8A04" },
];

const clock = z.string().refine((v) => parseClock(v) !== null, "invalid time");

const settingsSchema = z
  .object({
    timezone: z.string().refine(isValidTimeZone, "invalid timezone"),
    language: z.enum(["en", "ur", "ar", "es", "fr", "zh", "hi"]),
    quietStart: clock,
    quietEnd: clock,
    workStart: clock,
    workEnd: clock,
    dailyCapacityMinutes: z.number().int().min(60).max(960),
    notificationFrequency: z.enum(["ADAPTIVE", "FREQUENT", "MINIMAL", "NONE"]),
    notificationMethod: z.enum(["APP", "SOUND", "VIBRATION", "SOUND_VIBRATION"]),
    notificationDevices: z.enum(["ALL", "PHONE", "DESKTOP", "WHATSAPP"]),
    criticalOverridesDnd: z.boolean(),
    dndUntil: z.string().datetime().nullable(),
    currentContext: z.string().max(60).nullable(),
    contexts: z.array(z.string().trim().min(1).max(60)).max(12),
    tier: z.enum(["FREE", "PRO"]),
    onboardingCompleted: z.boolean(),
    tutorialsEnabled: z.boolean(),
    tutorialsSeen: z.array(z.string().max(60)).max(100),
    dismissedInsights: z.array(z.string().max(120)).max(500),
    ttsEnabled: z.boolean(),
    ttsRate: z.number().min(0.5).max(2),
  })
  .partial();

function normalizeClock(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const c = parseClock(value);
  return c ? `${String(c.h).padStart(2, "0")}:${String(c.m).padStart(2, "0")}` : undefined;
}

export const settingsRouter = Router();
settingsRouter.use(requireFirebaseUser, requireUser);

settingsRouter.get(
  "/",
  handle(async (req, res) => {
    sendSuccess(res, { settings: req.settings, phoneNumber: req.user.phoneNumber });
  }),
);

settingsRouter.put(
  "/",
  handle(async (req, res) => {
    const body = parseBody(settingsSchema, req.body);
    const data: Prisma.UserSettingsUpdateInput = {
      ...body,
      quietStart: normalizeClock(body.quietStart),
      quietEnd: normalizeClock(body.quietEnd),
      workStart: normalizeClock(body.workStart),
      workEnd: normalizeClock(body.workEnd),
      dndUntil: body.dndUntil === undefined ? undefined : body.dndUntil ? new Date(body.dndUntil) : null,
    };
    if (body.contexts && body.currentContext && !body.contexts.includes(body.currentContext)) {
      throw new HttpError(400, "VALIDATION_ERROR", "Current context must be one of your contexts");
    }
    const settings = await prisma.userSettings.update({ where: { userId: req.user.id }, data });
    if (body.timezone && body.timezone !== req.settings.timezone) await recomputeDueAts(req.user.id, body.timezone);
    if (body.currentContext !== undefined && body.currentContext !== req.settings.currentContext) {
      logEvent(req.user.id, "CONTEXT_SWITCHED", null, { context: body.currentContext });
    }
    sendSuccess(res, { settings }, "Preferences saved");
  }),
);

/** Do Not Disturb for a duration (FR-RN-003 §3). */
settingsRouter.post(
  "/dnd",
  handle(async (req, res) => {
    const { minutes } = parseBody(z.object({ minutes: z.number().int().min(0).max(24 * 60) }), req.body);
    const settings = await prisma.userSettings.update({
      where: { userId: req.user.id },
      data: { dndUntil: minutes > 0 ? new Date(Date.now() + minutes * 60000) : null },
    });
    sendSuccess(res, { settings }, minutes > 0 ? "Do Not Disturb on" : "Do Not Disturb off");
  }),
);

settingsRouter.put(
  "/phone",
  handle(async (req, res) => {
    const { phoneNumber } = parseBody(
      z.object({ phoneNumber: z.string().regex(/^\+[1-9]\d{7,14}$/, "Use international format, e.g. +923001234567").nullable() }),
      req.body,
    );
    if (phoneNumber) {
      const taken = await prisma.user.findFirst({ where: { phoneNumber, NOT: { id: req.user.id } } });
      if (taken) throw new HttpError(409, "PHONE_TAKEN", "That phone number is linked to another account");
    }
    const user = await prisma.user.update({ where: { id: req.user.id }, data: { phoneNumber } });
    sendSuccess(res, { phoneNumber: user.phoneNumber }, "Phone number saved");
  }),
);

export const categoryRouter = Router();
categoryRouter.use(requireFirebaseUser, requireUser);

categoryRouter.get(
  "/",
  handle(async (req, res) => {
    const custom = await prisma.category.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "asc" } });
    sendSuccess(res, {
      categories: [
        ...PREDEFINED_CATEGORIES.map((c) => ({ id: `predefined:${c.name}`, ...c, predefined: true })),
        ...custom.map((c) => ({ id: c.id, name: c.name, color: c.color, predefined: false })),
      ],
    });
  }),
);

const categoryBody = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

categoryRouter.post(
  "/",
  handle(async (req, res) => {
    const body = parseBody(categoryBody, req.body);
    if (PREDEFINED_CATEGORIES.some((c) => c.name.toLowerCase() === body.name.toLowerCase())) {
      throw new HttpError(409, "CATEGORY_EXISTS", "That category already exists");
    }
    try {
      const category = await prisma.category.create({ data: { userId: req.user.id, ...body } });
      sendSuccess(res, { category: { ...category, predefined: false } }, "Category created", 201);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new HttpError(409, "CATEGORY_EXISTS", "That category already exists");
      }
      throw error;
    }
  }),
);

categoryRouter.put(
  "/:id",
  handle(async (req, res) => {
    const body = parseBody(categoryBody.partial(), req.body);
    const existing = await prisma.category.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!existing) throw new HttpError(404, "CATEGORY_NOT_FOUND", "Category not found");
    const category = await prisma.category.update({ where: { id: existing.id }, data: body });
    if (body.name && body.name !== existing.name) {
      await prisma.task.updateMany({ where: { userId: req.user.id, category: existing.name }, data: { category: body.name } });
      await prisma.routine.updateMany({ where: { userId: req.user.id, category: existing.name }, data: { category: body.name } });
    }
    sendSuccess(res, { category: { ...category, predefined: false } }, "Category updated");
  }),
);

categoryRouter.delete(
  "/:id",
  handle(async (req, res) => {
    const existing = await prisma.category.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!existing) throw new HttpError(404, "CATEGORY_NOT_FOUND", "Category not found");
    await prisma.category.delete({ where: { id: existing.id } });
    await prisma.task.updateMany({ where: { userId: req.user.id, category: existing.name }, data: { category: null } });
    sendSuccess(res, {}, "Category deleted");
  }),
);

export const tagRouter = Router();
tagRouter.use(requireFirebaseUser, requireUser);

tagRouter.get(
  "/",
  handle(async (req, res) => {
    sendSuccess(res, { tags: await knownTags(req.user.id) });
  }),
);

tagRouter.delete(
  "/:tag",
  handle(async (req, res) => {
    const removed = await removeTagEverywhere({ userId: req.user.id, tz: req.settings.timezone, deviceId: req.deviceId }, req.params.tag);
    sendSuccess(res, { removed }, "Tag removed");
  }),
);
