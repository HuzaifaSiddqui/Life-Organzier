import type { Task } from "../types/models";
import { api, apiDelete, apiGet, apiPost } from "./api";
import { syncNow } from "./syncEngine";
import { scheduleReminderSync } from "./reminders";

export type DocType = "SYLLABUS" | "SCHEDULE" | "NOTES" | "OTHER";

export type ExtractedDeadline = {
  index: number;
  title: string;
  activity: string;
  date: string | null;
  time: string | null;
  assumedTime: boolean;
  confidence: number;
  source: string;
  created?: boolean;
};

export type ExtractedSchedule = {
  index: number;
  title: string;
  daysOfWeek: number[];
  time: string | null;
  durationMinutes: number | null;
  room: string | null;
  instructor: string | null;
  confidence: number;
  source: string;
  created?: boolean;
};

export type CourseInfo = {
  code: string | null;
  name: string | null;
  instructor: string | null;
  prerequisites: string[];
  topics: string[];
  objectives: string[];
  grading: Array<{ item: string; weight: number }>;
  resources: string[];
};

export type ProcessResult = {
  document: { id: string; fileName: string; docType: DocType; ocrConfidence: number | null; createdAt: string };
  extracted: {
    deadlines: ExtractedDeadline[];
    schedules: ExtractedSchedule[];
    course: CourseInfo;
    ocrConfidence: number;
    warning: string | null;
    needsLanguage: boolean;
    method: string;
  };
  createdTasks: Task[];
  createdRoutines: Array<{ id: string; title: string }>;
  textPreview: string;
};

export type DocumentSummary = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  docType: DocType;
  ocrConfidence: number | null;
  createdAt: string;
  extracted: ProcessResult["extracted"] | null;
};

export async function uploadDocument(
  file: { uri: string; name: string; mimeType: string },
  docType: DocType,
  language: string,
  onProgress?: (fraction: number) => void,
): Promise<ProcessResult> {
  const form = new FormData();
  form.append("file", { uri: file.uri, name: file.name, type: file.mimeType } as unknown as Blob);
  form.append("docType", docType);
  form.append("language", language);
  form.append("autoCreate", "true");
  const res = await api.post("/documents", form, {
    headers: { "Content-Type": "multipart/form-data" },
    timeout: 180000,
    onUploadProgress: (e) => {
      if (onProgress && e.total) onProgress(e.loaded / e.total);
    },
  });
  const body = res.data as { success: boolean; data: ProcessResult; message?: string };
  if (!body.success) throw new Error(body.message ?? "Upload failed");
  void syncNow();
  scheduleReminderSync();
  return body.data;
}

export async function processText(text: string, docType: DocType, title: string): Promise<ProcessResult> {
  const result = await apiPost<ProcessResult>("/documents/text", { text, docType, title }, { timeout: 120000 });
  void syncNow();
  scheduleReminderSync();
  return result;
}

export async function listDocuments(): Promise<{ documents: DocumentSummary[]; usedBytes: number }> {
  return apiGet("/documents");
}

export async function deleteDocument(id: string): Promise<void> {
  await apiDelete(`/documents/${id}`);
}

export async function applyDocument(
  id: string,
  items: {
    deadlines: Array<{ title: string; date: string; time: string | null }>;
    schedules: Array<{ title: string; daysOfWeek: number[]; time: string | null; durationMinutes: number | null }>;
  },
): Promise<{ tasks: Task[]; routines: Array<{ id: string; title: string }> }> {
  const result = await apiPost<{ tasks: Task[]; routines: Array<{ id: string; title: string }> }>(`/documents/${id}/apply`, items);
  void syncNow();
  scheduleReminderSync();
  return result;
}
