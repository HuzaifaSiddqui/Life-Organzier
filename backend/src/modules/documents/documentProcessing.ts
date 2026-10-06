import { Prisma, Priority, RoutineFrequency, RoutinePriority, TaskSource, TaskType, type User, type UserSettings } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { dueDateFromYmd } from "../../lib/time.js";
import { rememberFact } from "../memory/memoryService.js";
import { createRoutine } from "../routines/routineService.js";
import { createTask, serializeTask } from "../tasks/taskService.js";
import { cleanDocumentText, extractCourseInfo, extractDeadlines, extractSchedules, llmTopics, type CourseInfo, type ExtractedDeadline, type ExtractedSchedule } from "./extraction.js";
import { extractText } from "./textExtraction.js";

export const DOC_TYPES = ["SYLLABUS", "SCHEDULE", "NOTES", "OTHER"] as const;

/** Auto-creation thresholds from FR-DP-002 §4 and FR-DP-003 §4. */
const DEADLINE_AUTO = 95;
const SCHEDULE_AUTO = 90;

type Extracted = {
  deadlines: Array<ExtractedDeadline & { created?: boolean; taskId?: string }>;
  schedules: Array<ExtractedSchedule & { created?: boolean; routineId?: string }>;
  course: CourseInfo;
  ocrConfidence: number;
  warning: string | null;
  needsLanguage: boolean;
  method: string;
};

export async function processDocument(
  user: User,
  settings: UserSettings,
  input: { buffer?: Buffer; text?: string; fileName: string; mimeType: string; docType: (typeof DOC_TYPES)[number]; language: string; autoCreate: boolean },
) {
  const tz = settings.timezone;
  const raw = input.text !== undefined
    ? { text: input.text, confidence: 100, method: "text" as const, warning: null, needsLanguage: false }
    : await extractText(input.buffer as Buffer, input.mimeType, input.fileName, input.language);
  const text = cleanDocumentText(raw.text);
  const now = new Date();
  const deadlines = input.docType === "NOTES" ? [] : extractDeadlines(text, now, tz);
  const schedules = input.docType === "NOTES" ? [] : extractSchedules(text, now, tz);
  const course = extractCourseInfo(text);
  if (input.docType === "SYLLABUS" && !course.topics.length && text.length > 200) course.topics = await llmTopics(text);
  if (course.code) {
    for (const s of schedules) {
      if (/^(?:lectures?|class(?:es)?|labs?|tutorials?|sessions?|sections?)$/i.test(s.title)) s.title = `${course.code} ${s.title}`;
    }
  }

  const document = await prisma.document.create({
    data: {
      userId: user.id,
      fileName: input.fileName.slice(0, 200),
      mimeType: input.mimeType,
      sizeBytes: input.buffer?.length ?? Buffer.byteLength(input.text ?? ""),
      docType: input.docType,
      language: input.language,
      text: text.slice(0, 200000),
      ocrConfidence: raw.confidence,
    },
  });

  const extracted: Extracted = { deadlines, schedules, course, ocrConfidence: raw.confidence, warning: raw.warning, needsLanguage: raw.needsLanguage, method: raw.method };
  const createdTasks = [];
  const createdRoutines = [];
  if (input.autoCreate && !raw.needsLanguage && raw.confidence >= 70) {
    for (const d of extracted.deadlines) {
      if (d.confidence < DEADLINE_AUTO || !d.date) continue;
      const task = await createTask(
        { userId: user.id, tz },
        {
          title: d.title,
          priority: /final|midterm|exam/i.test(d.activity) ? Priority.HIGH : Priority.MEDIUM,
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
      const routine = await createRoutine(user.id, tz, {
        title: s.room ? `${s.title} (Room ${s.room})` : s.title,
        description: s.instructor ? `Instructor: ${s.instructor}` : null,
        frequency: s.frequency ?? RoutineFrequency.WEEKLY,
        daysOfWeek: s.daysOfWeek,
        dueTime: s.time,
        durationMinutes: s.durationMinutes,
        category: "Academic",
        priority: RoutinePriority.IMPORTANT,
        timeLocked: true,
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
  return { document: doc, extracted, createdTasks, createdRoutines, textPreview: text.slice(0, 1500) };
}

