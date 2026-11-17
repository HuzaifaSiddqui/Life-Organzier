import { background } from "../../lib/background.js";
import { keepFacts, learnFromDocument } from "./knowledge.js";
import { docKnowledgeOn } from "./knowledgeRules.js";
import { Prisma } from "@prisma/client";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { prisma } from "../../config/db.js";
import { handle, HttpError, parseBody, requireUser } from "../../lib/http.js";
import { requireFirebaseUser } from "../../middleware/authMiddleware.js";
import { sendSuccess } from "../../utils/apiResponse.js";
import { applyDocumentItems } from "./applyItems.js";
import { analyzeDocument, DOC_INPUT_TYPES, DOC_TYPES, EXTRACTOR_VERSION, processDocument, reviewResult, withInstruction } from "./documentProcessing.js";
import { recordUploadInChat } from "./chatUpload.js";
import { docInstructionsOn } from "./instructions.js";
import { localYmd } from "../../lib/time.js";
import { removeDocumentFiles } from "../../lib/storage.js";
import { readOriginal, readPage, readThumbnail } from "./documentFiles.js";
import { extractDeadlines } from "./extraction.js";
import { DOC_KINDS, docFlag, itemsFromPickedLines } from "./routing.js";
import { OcrBusyError } from "./textExtraction.js";
import { SUPPORTED_MIME } from "./textExtraction.js";

const MAX_BYTES = 10 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });

const LANGS = ["eng", "urd", "ara", "spa", "fra", "hin", "chi_sim"] as const;

/** The OCR queue is full: 503 with a plain "try again in a minute" (the phone shows the message). */
async function busyAsHttp<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof OcrBusyError) throw new HttpError(503, "OCR_BUSY", "I'm reading other documents right now. Please try again in a minute.");
    throw error;
  }
}

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
      z.object({
        docType: z.enum(DOC_INPUT_TYPES).default("OTHER"),
        language: z.enum(LANGS).default("eng"),
        autoCreate: z.enum(["true", "false"]).default("true"),
        instruction: z.string().max(300).optional(),
        // Sent from the assistant chat: the exchange is written into that conversation ("" = the current one).
        chat: z.enum(["true", "false"]).default("false"),
        conversationId: z.string().max(60).optional(),
      }),
      req.body,
    );
    // React Native percent-encodes non-ASCII file names in multipart uploads ("%E2%80%94" for "—").
    let fileName = file.originalname;
    try {
      fileName = decodeURIComponent(fileName);
    } catch {
      // not encoded
    }
    const result = await busyAsHttp(processDocument(req.user, req.settings, {
      buffer: file.buffer,
      fileName,
      mimeType: mime,
      docType: body.docType,
      language: body.language,
      autoCreate: body.autoCreate === "true",
      // DOC_INSTRUCTIONS: "What do you need from this document?" (read only with the flag on).
      ...(docInstructionsOn() && body.instruction?.trim() ? { instruction: body.instruction } : {}),
    }));
    const chat = body.chat === "true" ? await recordUploadInChat(req.user.id, req.settings.language, body.conversationId || null, result, body.instruction ?? null) : null;
    // DOC_KNOWLEDGE: read it for search and for facts about the user after answering (the app polls /:id/learning).
    const learning = Boolean(chat && docKnowledgeOn());
    if (chat && learning) background(learnFromDocument(req.user.id, result.document.id, chat.conversationId, req.settings.language));
    sendSuccess(res, { ...result, ...(chat ? { chat: { ...chat, learning } } : {}) }, "Document processed", 201);
  }),
);

documentRouter.post(
  "/text",
  handle(async (req, res) => {
    const body = parseBody(
      z.object({ text: z.string().min(10).max(200000), docType: z.enum(DOC_INPUT_TYPES).default("OTHER"), title: z.string().max(120).default("Pasted text"), autoCreate: z.boolean().default(true), instruction: z.string().max(300).optional() }),
      req.body,
    );
    const result = await processDocument(req.user, req.settings, {
      text: body.text,
      fileName: body.title,
      mimeType: "text/plain",
      docType: body.docType,
      language: "eng",
      autoCreate: body.autoCreate,
      ...(docInstructionsOn() && body.instruction?.trim() ? { instruction: body.instruction } : {}),
    });
    sendSuccess(res, result, "Document processed", 201);
  }),
);

/**
 * DOC_INSTRUCTIONS: change what is wanted from a document ("Change request"), or answer "which one?" with a person.
 * Re-filters the stored items: no OCR, no new reading, nothing created. An empty instruction shows everything.
 */
documentRouter.post(
  "/:id/instruction",
  handle(async (req, res) => {
    if (!docInstructionsOn()) throw new HttpError(404, "FEATURE_OFF", "Not available");
    const body = parseBody(z.object({ instruction: z.string().max(300), person: z.string().min(1).max(80).optional() }), req.body);
    const doc = await prisma.document.findFirst({ where: { id: String(req.params.id), userId: req.user.id } });
    if (!doc?.extracted) throw new HttpError(404, "NOT_FOUND", "Document not found");
    const extracted = await withInstruction(doc.text, doc.extracted as unknown as Parameters<typeof withInstruction>[1], body.instruction, body.person ?? null, localYmd(new Date(), req.settings.timezone));
    const saved = await prisma.document.update({ where: { id: doc.id }, data: { extracted: extracted as unknown as Prisma.InputJsonValue } });
    const { text: _t, ...document } = saved;
    sendSuccess(res, { document, extracted });
  }),
);

documentRouter.get(
  "/",
  handle(async (req, res) => {
    const documents = await prisma.document.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, fileName: true, mimeType: true, sizeBytes: true, docType: true, ocrConfidence: true, createdAt: true, extracted: true, fileStored: true, hasThumbnail: true, pageCount: true },
    });
    const usedBytes = documents.reduce((s, d) => s + d.sizeBytes, 0);
    sendSuccess(res, { documents, usedBytes, features: { instructions: docInstructionsOn() } });
  }),
);

documentRouter.get(
  "/:id",
  handle(async (req, res) => {
    const document = await prisma.document.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!document) throw new HttpError(404, "DOCUMENT_NOT_FOUND", "Document not found");
    // `result`: the saved reading in the upload's shape, for the review screen (opened from chat or My documents).
    sendSuccess(res, { document, result: await reviewResult(req.user.id, document) });
  }),
);

documentRouter.delete(
  "/:id",
  handle(async (req, res) => {
    const result = await prisma.document.deleteMany({ where: { id: req.params.id, userId: req.user.id } });
    if (!result.count) throw new HttpError(404, "DOCUMENT_NOT_FOUND", "Document not found");
    await removeDocumentFiles(req.user.id, req.params.id).catch((error: unknown) => console.warn("Document files not removed", error));
    sendSuccess(res, {}, "Document deleted");
  }),
);

async function ownDocument(userId: string, id: string) {
  const doc = await prisma.document.findFirst({ where: { id, userId }, select: { id: true, fileName: true, mimeType: true, pageCount: true, fileStored: true, hasThumbnail: true } });
  if (!doc) throw new HttpError(404, "DOCUMENT_NOT_FOUND", "Document not found");
  return doc;
}

/** The tile image (JPEG, base64): a photo or a PDF's first page. 404 when the document has none. */
documentRouter.get(
  "/:id/thumbnail",
  handle(async (req, res) => {
    const doc = await ownDocument(req.user.id, req.params.id);
    const image = doc.hasThumbnail ? await readThumbnail(req.user.id, doc.id) : null;
    if (!image) throw new HttpError(404, "NO_PREVIEW", "No preview for this document");
    res.setHeader("Cache-Control", "private, max-age=86400");
    sendSuccess(res, { mime: "image/jpeg", data: image.toString("base64") });
  }),
);

/** One page for the preview screen (JPEG, base64): PDF page `page` (from 1), or the photo itself. */
documentRouter.get(
  "/:id/pages/:page",
  handle(async (req, res) => {
    const doc = await ownDocument(req.user.id, req.params.id);
    const image = doc.fileStored ? await readPage(req.user.id, doc, Number(req.params.page)) : null;
    if (!image) throw new HttpError(404, "NO_PREVIEW", "No preview for this page");
    res.setHeader("Cache-Control", "private, max-age=86400");
    sendSuccess(res, { mime: "image/jpeg", data: image.toString("base64"), page: Number(req.params.page), pageCount: doc.pageCount });
  }),
);

/** The original file (base64), for "Open in another app" / download. */
documentRouter.get(
  "/:id/file",
  handle(async (req, res) => {
    const doc = await ownDocument(req.user.id, req.params.id);
    const file = doc.fileStored ? await readOriginal(req.user.id, doc.id) : null;
    if (!file) throw new HttpError(404, "NO_FILE", "The original file isn't kept for this document");
    sendSuccess(res, { filename: doc.fileName, mime: doc.mimeType, data: file.toString("base64") });
  }),
);

/** DOC_KNOWLEDGE: whether reading a chat document for facts has finished, and the chat message it added (if any). */
documentRouter.get(
  "/:id/learning",
  handle(async (req, res) => {
    const doc = await prisma.document.findFirst({ where: { id: String(req.params.id), userId: req.user.id }, select: { knowledge: true } });
    if (!doc) throw new HttpError(404, "DOCUMENT_NOT_FOUND", "Document not found");
    const k = doc.knowledge as { status?: string; messageId?: string } | null;
    sendSuccess(res, { status: k?.status ?? "none", messageId: k?.messageId ?? null });
  }),
);

/** DOC_KNOWLEDGE: the facts the user ticked on the chat card go into memory. */
documentRouter.post(
  "/:id/facts",
  handle(async (req, res) => {
    const body = parseBody(z.object({ keep: z.array(z.string().min(1).max(20)).max(10) }), req.body);
    const r = await keepFacts(req.user.id, String(req.params.id), body.keep);
    if (!r) throw new HttpError(404, "DOCUMENT_NOT_FOUND", "Document not found");
    sendSuccess(res, r, r.kept ? `Remembered ${r.kept}` : "Nothing remembered");
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
              location: z.string().trim().max(60).nullable().optional(),
            }),
          )
          .max(60)
          .default([]),
      }),
      req.body,
    );
    const document = await prisma.document.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!document) throw new HttpError(404, "DOCUMENT_NOT_FOUND", "Document not found");
    const { tasks, routines, skipped } = await applyDocumentItems({ userId: req.user.id, tz: req.settings.timezone, deviceId: req.deviceId }, document.id, body);
    sendSuccess(res, { tasks, routines, skipped }, `Created ${tasks.length} tasks and ${routines.length} routines${skipped ? ` (${skipped} already existed)` : ""}`);
  }),
);

/** DOC_FALLBACK_UI: review items from lines the user picked in "See what was read". Creates nothing. */
documentRouter.post(
  "/:id/pick-lines",
  handle(async (req, res) => {
    if (!docFlag("DOC_FALLBACK_UI")) throw new HttpError(404, "NOT_FOUND", "Not found");
    const body = parseBody(z.object({ lines: z.array(z.string().trim().min(1).max(300)).min(1).max(40) }), req.body);
    const document = await prisma.document.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!document) throw new HttpError(404, "DOCUMENT_NOT_FOUND", "Document not found");
    const deadlines = itemsFromPickedLines(body.lines, document.text, (line) => extractDeadlines(line, new Date(), req.settings.timezone));
    if (!deadlines) throw new HttpError(400, "VALIDATION_ERROR", "Pick lines from the document's text");
    sendSuccess(res, { deadlines });
  }),
);

/** DOC_ROUTING "Wrong type?": the stored (masked) text read again as the type the user picked. Creates nothing. */
documentRouter.post(
  "/:id/reextract",
  handle(async (req, res) => {
    if (!docFlag("DOC_ROUTING")) throw new HttpError(404, "NOT_FOUND", "Not found");
    const body = parseBody(z.object({ kind: z.enum(DOC_KINDS) }), req.body);
    const document = await prisma.document.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!document) throw new HttpError(404, "DOCUMENT_NOT_FOUND", "Document not found");
    const a = await busyAsHttp(analyzeDocument({ text: document.text, fileName: document.fileName, mimeType: "text/plain", docType: document.docType as (typeof DOC_TYPES)[number], language: document.language, tz: req.settings.timezone, kind: body.kind }));
    const extracted = { deadlines: a.deadlines, schedules: a.schedules, course: a.course, ocrConfidence: document.ocrConfidence ?? a.ocrConfidence, warning: a.warning, needsLanguage: a.needsLanguage, method: a.method, extractorVersion: EXTRACTOR_VERSION, kind: a.kind };
    await prisma.document.update({ where: { id: document.id }, data: { extracted: extracted as unknown as Prisma.InputJsonValue } });
    sendSuccess(res, { extracted });
  }),
);
