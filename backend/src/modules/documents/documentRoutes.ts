import { Priority, RoutineFrequency, RoutinePriority, TaskSource, TaskType } from "@prisma/client";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { prisma } from "../../config/db.js";
import { handle, HttpError, parseBody, requireUser } from "../../lib/http.js";
import { dueDateFromYmd, parseClock } from "../../lib/time.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendSuccess } from "../../utils/apiResponse.js";
import { createRoutine } from "../routines/routineService.js";
import { createTask, serializeTask } from "../tasks/taskService.js";
import { DOC_TYPES, existingRoutineId, existingTaskId, processDocument } from "./documentProcessing.js";
import { SUPPORTED_MIME } from "./textExtraction.js";

const MAX_BYTES = 10 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });

const LANGS = ["eng", "urd", "ara", "spa", "fra", "hin", "chi_sim"] as const;

export const documentRouter = Router();
documentRouter.use(requireFirebaseUser, requireUser);

documentRouter.post(
  "/",
  (req, res, next) => {
    upload.single("file")(req, res, (error: unknown) => {
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ success: false, message: "File is larger than 10 MB", error: "FILE_TOO_LARGE" });
        return;
      }
      if (error) {
        next(error);
        return;
      }
      next();
    });
  },
  handle(async (req, res) => {
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) throw new HttpError(400, "VALIDATION_ERROR", "Attach a file (PDF, JPG, PNG or DOCX)");
    const mime = file.mimetype === "image/jpg" ? "image/jpeg" : file.mimetype;
    if (!SUPPORTED_MIME.includes(mime) && !/\.(pdf|docx|png|jpe?g|txt)$/i.test(file.originalname)) {
      throw new HttpError(415, "UNSUPPORTED_FILE", "Supported formats: PDF, JPG, PNG, DOCX");
    }
    const body = parseBody(
      z.object({ docType: z.enum(DOC_TYPES).default("OTHER"), language: z.enum(LANGS).default("eng"), autoCreate: z.enum(["true", "false"]).default("true") }),
      req.body,
    );
    // React Native percent-encodes non-ASCII file names in multipart uploads ("%E2%80%94" for "—").
    let fileName = file.originalname;
    try {
      fileName = decodeURIComponent(fileName);
    } catch {
      // not encoded
    }
    const result = await processDocument(req.user, req.settings, {
      buffer: file.buffer,
      fileName,
      mimeType: mime,
      docType: body.docType,
      language: body.language,
      autoCreate: body.autoCreate === "true",
    });
    sendSuccess(res, result, "Document processed", 201);
  }),
);

documentRouter.post(
  "/text",
  handle(async (req, res) => {
    const body = parseBody(
      z.object({ text: z.string().min(10).max(200000), docType: z.enum(DOC_TYPES).default("OTHER"), title: z.string().max(120).default("Pasted text"), autoCreate: z.boolean().default(true) }),
      req.body,
    );
    const result = await processDocument(req.user, req.settings, {
      text: body.text,
      fileName: body.title,
      mimeType: "text/plain",
      docType: body.docType,
      language: "eng",
      autoCreate: body.autoCreate,
    });
    sendSuccess(res, result, "Document processed", 201);
  }),
);

documentRouter.get(
  "/",
  handle(async (req, res) => {
    const documents = await prisma.document.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, fileName: true, mimeType: true, sizeBytes: true, docType: true, ocrConfidence: true, createdAt: true, extracted: true },
    });
    const usedBytes = documents.reduce((s, d) => s + d.sizeBytes, 0);
    sendSuccess(res, { documents, usedBytes });
  }),
);

documentRouter.get(
  "/:id",
  handle(async (req, res) => {
    const document = await prisma.document.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!document) throw new HttpError(404, "DOCUMENT_NOT_FOUND", "Document not found");
    sendSuccess(res, { document });
  }),
);

documentRouter.delete(
  "/:id",
  handle(async (req, res) => {
    const result = await prisma.document.deleteMany({ where: { id: req.params.id, userId: req.user.id } });
    if (!result.count) throw new HttpError(404, "DOCUMENT_NOT_FOUND", "Document not found");
    sendSuccess(res, {}, "Document deleted");
  }),
);

/** Creates the user-confirmed / corrected items (checkbox + edit flow, FR-DP-002 §3). */
documentRouter.post(
  "/:id/apply",
  handle(async (req, res) => {
    const body = parseBody(
      z.object({
        deadlines: z
          .array(z.object({ title: z.string().trim().min(1).max(200), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().nullable().optional() }))
          .max(60)
          .default([]),
        schedules: z
          .array(
            z.object({
              title: z.string().trim().min(1).max(200),
              daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
              time: z.string().nullable().optional(),
              durationMinutes: z.number().int().positive().nullable().optional(),
            }),
          )
          .max(60)
          .default([]),
      }),
      req.body,
    );
    const document = await prisma.document.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!document) throw new HttpError(404, "DOCUMENT_NOT_FOUND", "Document not found");
    const tz = req.settings.timezone;
    const tasks = [];
    let skipped = 0;
    for (const d of body.deadlines) {
      const time = d.time && parseClock(d.time) ? d.time : "11:59 PM";
      if (await existingTaskId(req.user.id, d.title, dueDateFromYmd(d.date, tz), time)) {
        skipped += 1;
        continue;
      }
      tasks.push(
        serializeTask(
          await createTask(
            { userId: req.user.id, tz, deviceId: req.deviceId },
            { title: d.title, priority: Priority.MEDIUM, category: "Academic", source: TaskSource.DOCUMENT, dueDate: dueDateFromYmd(d.date, tz), dueTime: time, taskType: TaskType.DEADLINE, documentId: document.id, confidence: 100 },
          ),
        ),
      );
    }
    const routines = [];
    for (const s of body.schedules) {
      if (await existingRoutineId(req.user.id, s.title, s.daysOfWeek, s.time && parseClock(s.time) ? s.time : null)) {
        skipped += 1;
        continue;
      }
      routines.push(
        await createRoutine(req.user.id, tz, {
          title: s.title,
          frequency: RoutineFrequency.WEEKLY,
          daysOfWeek: s.daysOfWeek,
          dueTime: s.time && parseClock(s.time) ? s.time : null,
          durationMinutes: s.durationMinutes ?? null,
          category: "Academic",
          priority: RoutinePriority.IMPORTANT,
          timeLocked: true,
        }),
      );
    }
    sendSuccess(res, { tasks, routines, skipped }, `Created ${tasks.length} tasks and ${routines.length} routines${skipped ? ` (${skipped} already existed)` : ""}`);
  }),
);
