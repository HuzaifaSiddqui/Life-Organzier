import crypto from "node:crypto";
import { Prisma, Priority, RoutineFrequency, RoutinePriority, TaskSource, TaskStatus, TaskType, type User, type UserSettings } from "@prisma/client";
import { AiService, getAi, OllamaProvider } from "../../ai/llm.js";
import { prisma } from "../../config/db.js";
import { dueDateFromYmd, localYmd } from "../../lib/time.js";
import { extractInterval } from "../assistant/entities.js";
import { rememberFact } from "../memory/memoryService.js";
import { createRoutine } from "../routines/routineService.js";
import { createTask, serializeTask } from "../tasks/taskService.js";
import { aiDeadlines, chunkText, cleanDocumentText, extractCourseInfo, extractDeadlines, extractSchedules, llmActionItems, llmTopics, maskPersonalNumbers, mergeDeadlines, type CourseInfo, type ExtractedDeadline, type ExtractedSchedule } from "./extraction.js";
import { AGREE_MAX_CALLS, agreeOnAiItems, REVIEW_DEADLINE, classifyDocument, docFlag, documentPriority, kindByRules, routeItems, verifyEvidence, type DocKind, type KindResult } from "./routing.js";
import { gridSchedulesFromImage, gridSchedulesFromPdf, hasClockGrid, layoutRows } from "./gridTimetable.js";
import { extractText } from "./textExtraction.js";

export const DOC_TYPES = ["SYLLABUS", "SCHEDULE", "NOTES", "OTHER"] as const;

/**
 * Re-uploading the same file (or a newer version of it) must not create every task and routine
 * again: an active one with the same title and the same date/time or days/time counts as existing.
 */
export async function existingTaskId(userId: string, title: string, dueDate: Date, dueTime: string | null): Promise<string | null> {
  const t = await prisma.task.findFirst({
    where: { userId, title: { equals: title, mode: "insensitive" }, dueDate, dueTime, status: { not: TaskStatus.DELETED } },
    select: { id: true },
  });
  return t?.id ?? null;
}

/** Same class already saved? Also matches the old title style "Physics (Room B-12)" from before Routine.location existed. */
export async function existingRoutineId(userId: string, title: string, daysOfWeek: number[], dueTime: string | null, room?: string | null): Promise<string | null> {
  const titles = room ? [title, `${title} (Room ${room})`] : [title];
  const candidates = await prisma.routine.findMany({
    where: { userId, active: true, OR: titles.map((t) => ({ title: { equals: t, mode: "insensitive" as const } })), dueTime },
    select: { id: true, daysOfWeek: true },
  });
  const key = [...daysOfWeek].sort().join(",");
  const hit = candidates.find((r) => (Array.isArray(r.daysOfWeek) ? [...(r.daysOfWeek as number[])].sort().join(",") : "") === key);
  return hit?.id ?? null;
}

/** Auto-creation thresholds from FR-DP-002 §4 and FR-DP-003 §4. */
export const DEADLINE_AUTO = 95;
export const SCHEDULE_AUTO = 90;
/** Below this OCR confidence a title may be misread ("Broject"), so OCR'd deadlines always go to review. */
export const OCR_AUTO_MIN = 90;

/** Caps deadlines read by OCR at less than DEADLINE_AUTO when the page read poorly. Typed text and text-layer PDFs are unchanged. */
export function capOcrConfidence<T extends { confidence: number }>(deadlines: T[], method: string, ocrConfidence: number): T[] {
  if ((method === "ocr" || method === "pdf-ocr") && ocrConfidence < OCR_AUTO_MIN) {
    for (const d of deadlines) d.confidence = Math.min(d.confidence, DEADLINE_AUTO - 1);
  }
  return deadlines;
}

type Extracted = {
  /** removedSinceUpload: it was added from this document but has been deleted since (a reused result says so). */
  deadlines: Array<ExtractedDeadline & { created?: boolean; existing?: boolean; taskId?: string; removedSinceUpload?: boolean }>;
  schedules: Array<ExtractedSchedule & { created?: boolean; existing?: boolean; routineId?: string; removedSinceUpload?: boolean }>;
  course: CourseInfo;
  ocrConfidence: number;
  warning: string | null;
  needsLanguage: boolean;
  method: string;
  /** EXTRACTOR_VERSION that produced it; a saved result from another version is read again, not reused. */
  extractorVersion?: number;
  /** DOC_ROUTING: the detected (or picked) type. Absent on older documents. */
  kind?: KindResult;
};

/**
 * Bump when the readers change what a document yields (new formats, new rules): a re-upload within the reuse
 * window is then read again instead of replaying the old result. 2 = grid timetables from images.
 */
export const EXTRACTOR_VERSION = 2;

export type AnalyzeInput = {
  buffer?: Buffer;
  text?: string;
  fileName: string;
  mimeType: string;
  docType: (typeof DOC_TYPES)[number];
  language: string;
  tz: string;
  now?: Date;
  /** Test hook: a shorter DOCUMENT_TIME_LIMIT_MS. */
  timeLimitMs?: number;
  /** DOC_ROUTING: the type the user picked ("wrong type?"), instead of detecting it. */
  kind?: DocKind;
};

export type Analysis = {
  /** Cleaned and masked text (what is stored and what a model may see). */
  text: string;
  deadlines: ExtractedDeadline[];
  schedules: ExtractedSchedule[];
  course: CourseInfo;
  ocrConfidence: number;
  warning: string | null;
  needsLanguage: boolean;
  method: string;
  grid: boolean;
  /** DOC_ROUTING (or DOC_AGREE): the detected or picked document type. */
  kind?: KindResult;
};

/**
 * Time allowed per document, OCR plus the AI pass. OCR has its own limits (45 s an image, 90 s a scanned PDF);
 * the AI pass and the topics call get what is left. When it runs out, what the rules found is returned with a
 * warning instead of failing. The phone's upload timeout (mobile documentsApi.ts) is longer than this.
 */
export const DOCUMENT_TIME_LIMIT_MS = 150_000;
/** Not worth starting a model call with less time than this. */
const MIN_AI_MS = 10_000;
/** A document that says "every other day" / "every N days": no routine is made from it here, and it says how (English only for now). */
export const INTERVAL_WARNING = "This mentions repeating every other day or every N days. Documents don't make those routines, so add it in chat (e.g. \"take medicine every other day\") or on the Routines screen.";
export const TIME_LIMIT_WARNING = "This document took long to read, so I didn't finish checking it with AI. The items below come from the rules; please check them.";

/**
 * Reads a document and extracts deadlines, schedules and course info. No database writes, so the
 * evaluation (`npm run eval:documents`) runs exactly what an upload runs.
 */
export async function analyzeDocument(input: AnalyzeInput): Promise<Analysis> {
  const { tz } = input;
  const started = Date.now();
  const left = () => (input.timeLimitMs ?? DOCUMENT_TIME_LIMIT_MS) - (Date.now() - started);
  let timedOut = false;
  const raw = input.text !== undefined
    ? { text: input.text, confidence: 100, method: "text" as const, warning: null, needsLanguage: false }
    : await extractText(input.buffer as Buffer, input.mimeType, input.fileName, input.language, started + (input.timeLimitMs ?? DOCUMENT_TIME_LIMIT_MS));
  // DOC_LAYOUT: an OCR'd table read as rows and columns (the flat text stays the fallback).
  const table = docFlag("DOC_LAYOUT") && "words" in raw && raw.words?.length ? layoutRows(raw.words) : null;
  const text = maskPersonalNumbers(cleanDocumentText(table ?? raw.text));
  const now = input.now ?? new Date();
  let deadlines = input.docType === "NOTES" ? [] : extractDeadlines(text, now, tz);
  let schedules = input.docType === "NOTES" ? [] : extractSchedules(text, now, tz);
  // Grid timetables lose their layout as plain text; read them by position instead.
  let grid = false;
  if (input.docType !== "NOTES" && input.buffer && /pdf/i.test(input.mimeType)) {
    const fromGrid = await gridSchedulesFromPdf(input.buffer).catch((error) => {
      console.warn("Grid timetable parse failed", error instanceof Error ? error.message : error);
      return [];
    });
    if (fromGrid.length >= 2) {
      schedules = fromGrid;
      grid = true;
    }
  } else if (input.docType !== "NOTES" && input.buffer && /^image\//i.test(input.mimeType) && hasClockGrid(raw.text)) {
    // A photo or screenshot of a grid timetable: plain OCR text loses which class sits in which day and slot.
    const fromGrid = await gridSchedulesFromImage(input.buffer, input.language, started + (input.timeLimitMs ?? DOCUMENT_TIME_LIMIT_MS)).catch((error) => {
      console.warn("Grid timetable image parse failed", error instanceof Error ? error.message : error);
      return [];
    });
    if (fromGrid.length >= 2) {
      schedules = fromGrid;
      grid = true;
    }
  }
  // AI pass on every document when AI is on (masked text only), merged with the rules.
  let aiNote: string | null = null;
  const todayYmd = localYmd(now, tz);
  if (input.docType !== "NOTES" && !raw.needsLanguage) {
    const aiOn = getAi().enabled && getAi().available;
    const pass = aiOn && left() >= MIN_AI_MS ? await aiDeadlines(text, todayYmd, tz, { budgetMs: left() }) : { items: [], cutShort: aiOn };
    timedOut = pass.cutShort;
    if (docFlag("DOC_EVIDENCE_V2")) {
      // The cited line was looked up and gives the date: verified; otherwise review only, no agreement bonus.
      const checked = pass.items.map((i) => (i.lineVerified ? i : { ...i, review: true, confidence: Math.min(i.confidence, REVIEW_DEADLINE) }));
      deadlines = mergeDeadlines(mergeDeadlines(deadlines, checked.filter((i) => i.lineVerified)), checked.filter((i) => !i.lineVerified), { agree: false });
    } else if (docFlag("DOC_EVIDENCE")) {
      // Only items whose source line is in the text (and gives their date) may agree with the rules.
      const checked = pass.items.map((i) => verifyEvidence(i, text));
      deadlines = mergeDeadlines(mergeDeadlines(deadlines, checked.filter((i) => i.verified)), checked.filter((i) => !i.verified), { agree: false });
    } else deadlines = mergeDeadlines(deadlines, pass.items);
    const dated = deadlines.filter((d) => d.date);
    if (dated.length && !schedules.length && dated.every((d) => d.date! < todayYmd)) aiNote = "Heads up: the dates in this file have already passed.";
  }
  capOcrConfidence(deadlines, raw.method, raw.confidence);
  let kind: KindResult | undefined;
  const routing = docFlag("DOC_ROUTING");
  if (input.docType !== "NOTES" && (routing || docFlag("DOC_AGREE"))) {
    const found = { deadlines, schedules, grid };
    kind = input.kind ? { kind: input.kind, confidence: 1, via: "user" } : routing && left() >= MIN_AI_MS ? await classifyDocument(text, found, Math.min(15000, left())) : kindByRules(text, found);
  }
  if (docFlag("DOC_AGREE") && kind && (kind.kind === "other" || raw.confidence < 70) && getAi().enabled && left() >= MIN_AI_MS) {
    // A second, local model on the same masked text (private documents stay on this machine).
    const second = new AiService([new OllamaProvider(undefined, process.env.DOC_AGREE_MODEL ?? "qwen2.5:14b")]);
    const end = Date.now() + left() - 5000;
    deadlines = (await agreeOnAiItems(deadlines, async () => {
      const out: ExtractedDeadline[] = [];
      for (const c of chunkText(text, 2500, 200, AGREE_MAX_CALLS)) if (end - Date.now() > 5000) out.push(...(await llmActionItems(c, todayYmd, tz, Math.min(60000, end - Date.now()), second)));
      return out;
    })).deadlines;
  }
  if (routing && kind) ({ deadlines, schedules } = routeItems(kind.kind, deadlines, schedules));
  // A grid lists many courses — picking one as "the course" would store a wrong memory.
  const course = extractCourseInfo(grid ? "" : text);
  if (input.docType === "SYLLABUS" && !grid && !course.topics.length && text.length > 200 && left() >= MIN_AI_MS) course.topics = await llmTopics(text, Math.min(45000, left()));
  if (course.code) {
    for (const s of schedules) {
      if (/^(?:lectures?|class(?:es)?|labs?|tutorials?|sessions?|sections?)$/i.test(s.title)) s.title = `${course.code} ${s.title}`;
    }
  }
  const intervalNote = input.docType !== "NOTES" && extractInterval(text) ? INTERVAL_WARNING : null;
  return { text, deadlines, schedules, course, ocrConfidence: raw.confidence, warning: raw.warning ?? (timedOut ? TIME_LIMIT_WARNING : intervalNote ?? aiNote), needsLanguage: raw.needsLanguage, method: grid ? (/pdf/i.test(input.mimeType) ? "pdf-grid" : "image-grid") : raw.method, grid, ...(kind ? { kind } : {}) };
}

type ProcessInput = { buffer?: Buffer; text?: string; fileName: string; mimeType: string; docType: (typeof DOC_TYPES)[number]; language: string; autoCreate: boolean };

/** DOC_FALLBACK_UI: how much of the extracted (masked) text the phone gets to show ("See what was read"). */
export const TEXT_FOR_VIEW = 20000;

/** A retry of the same file within this long gets the saved result instead of a second document. */
export const REUSE_WITHIN_MS = 24 * 3600000;

/** Same bytes (or pasted text), same type and language → same hash. */
export function documentHash(input: Pick<ProcessInput, "buffer" | "text" | "docType" | "language">): string {
  const h = crypto.createHash("sha256");
  h.update(input.buffer ?? Buffer.from(input.text ?? "", "utf8"));
  h.update(`|${input.docType}|${input.language}`);
  return h.digest("hex");
}

// ponytail: per server process; a second instance would not see the other's in-flight uploads (the 24 h reuse
// still works through the database).
const inFlight = new Map<string, ReturnType<typeof reuseOrProcess>>();

/**
 * Reads and saves a document. The server finishes even if the phone gave up waiting (its tasks are saved), so
 * a retry of the same file must not do it again: while the first upload is still running the retry shares its
 * result, and within 24 h it gets the saved document back (`reused: true`). No duplicate documents or tasks.
 */
export function processDocument(user: User, settings: UserSettings, input: ProcessInput) {
  const hash = documentHash(input);
  const key = `${user.id}:${hash}`;
  const running = inFlight.get(key);
  if (running) return running;
  // Registered before any await, so a second identical request arriving meanwhile joins this one.
  const job = reuseOrProcess(user, settings, input, hash).finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

async function reuseOrProcess(user: User, settings: UserSettings, input: ProcessInput, hash: string) {
  const recent = await prisma.document.findFirst({ where: { userId: user.id, contentHash: hash, createdAt: { gte: new Date(Date.now() - REUSE_WITHIN_MS) } }, orderBy: { createdAt: "desc" } });
  // Reuse avoids duplicate tasks, but only for a result from the current readers: an older one may have missed things.
  const saved = recent?.extracted as unknown as Extracted | null;
  if (recent && saved && saved.extractorVersion === EXTRACTOR_VERSION) {
    const { text, ...doc } = recent;
    return { document: doc, extracted: await withCurrentState(user.id, recent.extracted as unknown as Extracted), createdTasks: [] as ReturnType<typeof serializeTask>[], createdRoutines: [] as Awaited<ReturnType<typeof createRoutine>>[], textPreview: text.slice(0, 1500), ...(docFlag("DOC_FALLBACK_UI") ? { text: text.slice(0, TEXT_FOR_VIEW) } : {}), reused: true };
  }
  return processDocumentOnce(user, settings, input, hash);
}

/**
 * A saved result's created / existing flags as of now: an item whose task or routine was deleted (or archived)
 * since is offered again (not created, no id, removedSinceUpload) instead of claiming a task that is gone.
 * Nothing is re-created automatically: the user deleted it, so they decide.
 */
async function withCurrentState(userId: string, saved: Extracted): Promise<Extracted> {
  const extracted = structuredClone(saved);
  const taskIds = extracted.deadlines.map((d) => d.taskId).filter((id): id is string => Boolean(id));
  const routineIds = extracted.schedules.map((s) => s.routineId).filter((id): id is string => Boolean(id));
  const [tasks, routines] = await Promise.all([
    prisma.task.findMany({ where: { id: { in: taskIds }, userId, status: { not: TaskStatus.DELETED }, archived: false }, select: { id: true } }),
    prisma.routine.findMany({ where: { id: { in: routineIds }, userId }, select: { id: true } }),
  ]);
  const liveTasks = new Set(tasks.map((t) => t.id));
  const liveRoutines = new Set(routines.map((r) => r.id));
  for (const d of extracted.deadlines) {
    if (d.taskId && !liveTasks.has(d.taskId)) Object.assign(d, { created: false, existing: false, taskId: undefined, removedSinceUpload: true });
  }
  for (const s of extracted.schedules) {
    if (s.routineId && !liveRoutines.has(s.routineId)) Object.assign(s, { created: false, existing: false, routineId: undefined, removedSinceUpload: true });
  }
  return extracted;
}

async function processDocumentOnce(user: User, settings: UserSettings, input: ProcessInput, contentHash: string) {
  const tz = settings.timezone;
  const a = await analyzeDocument({ ...input, tz });
  const { text, deadlines, schedules, course } = a;
  const raw = { confidence: a.ocrConfidence, needsLanguage: a.needsLanguage };

  const document = await prisma.document.create({
    data: {
      userId: user.id,
      fileName: input.fileName.slice(0, 200),
      mimeType: input.mimeType,
      sizeBytes: input.buffer?.length ?? Buffer.byteLength(input.text ?? ""),
      docType: input.docType,
      language: input.language,
      text: text.slice(0, 200000),
      ocrConfidence: a.ocrConfidence,
      contentHash,
    },
  });

  const extracted: Extracted = { deadlines, schedules, course, ocrConfidence: a.ocrConfidence, warning: a.warning, needsLanguage: a.needsLanguage, method: a.method, extractorVersion: EXTRACTOR_VERSION, ...(a.kind ? { kind: a.kind } : {}) };
  const todayYmd = localYmd(new Date(), tz);
  const createdTasks = [];
  const createdRoutines = [];
  if (input.autoCreate && !raw.needsLanguage && raw.confidence >= 70) {
    for (const d of extracted.deadlines) {
      if (d.confidence < DEADLINE_AUTO || !d.date) continue;
      const already = await existingTaskId(user.id, d.title, dueDateFromYmd(d.date, tz), d.time);
      if (already) {
        d.created = true;
        d.existing = true;
        d.taskId = already;
        continue;
      }
      const task = await createTask(
        { userId: user.id, tz },
        {
          title: d.title,
          priority: docFlag("DOC_PRIORITY_V2") ? documentPriority(d, todayYmd, course.grading).priority : /final|midterm|exam/i.test(d.activity) ? Priority.HIGH : Priority.MEDIUM,
          category: "Academic",
          source: TaskSource.DOCUMENT,
          confidence: d.confidence,
          dueDate: dueDateFromYmd(d.date, tz),
          dueTime: d.time,
          taskType: TaskType.DEADLINE,
          documentId: document.id,
          tags: [d.activity.split(/\s+/)[0], "deadline"],
        },
      );
      d.created = true;
      d.taskId = task.id;
      createdTasks.push(serializeTask(task));
    }
    // Large timetables are always shown for confirmation first (FR-DP-003 §5).
    const autoSchedules = extracted.schedules.length <= 5;
    for (const s of extracted.schedules) {
      if (!autoSchedules || s.confidence < SCHEDULE_AUTO || !s.daysOfWeek.length) continue;
      // Clean title; the room (only ever taken from the document text) goes into its own field.
      const title = s.title;
      const already = await existingRoutineId(user.id, title, s.daysOfWeek, s.time, s.room);
      if (already) {
        s.created = true;
        s.existing = true;
        s.routineId = already;
        continue;
      }
      const routine = await createRoutine(user.id, tz, {
        title,
        description: s.instructor ? `Instructor: ${s.instructor}` : null,
        frequency: s.frequency ?? RoutineFrequency.WEEKLY,
        daysOfWeek: s.daysOfWeek,
        dueTime: s.time,
        durationMinutes: s.durationMinutes,
        category: "Academic",
        priority: RoutinePriority.IMPORTANT,
        timeLocked: true,
        location: s.room,
      });
      s.created = true;
      s.routineId = routine.id;
      createdRoutines.push(routine);
    }
  }

  // Course knowledge becomes long-term memory used for context & prerequisite questions (FR-DP-004).
  if (course.code || course.name) {
    const label = [course.code, course.name].filter(Boolean).join(" ");
    await rememberFact(user.id, {
      kind: "COURSE",
      content: `User is taking ${label}.${course.topics.length ? ` Topics: ${course.topics.slice(0, 8).join(", ")}.` : ""}${course.prerequisites.length ? ` Prerequisites: ${course.prerequisites.join(", ")}.` : ""}${course.instructor ? ` Instructor: ${course.instructor}.` : ""}`,
      importance: 0.7,
      source: `document:${document.id}`,
      metadata: { code: course.code, name: course.name, topics: course.topics, prerequisites: course.prerequisites, instructor: course.instructor, documentId: document.id },
    });
  }

  const updated = await prisma.document.update({ where: { id: document.id }, data: { extracted: extracted as unknown as Prisma.InputJsonValue } });
  const { text: _t, ...doc } = updated;
  return { document: doc, extracted, createdTasks, createdRoutines, textPreview: text.slice(0, 1500), ...(docFlag("DOC_FALLBACK_UI") ? { text: text.slice(0, TEXT_FOR_VIEW) } : {}), reused: false };
}

