import type { Task } from "../types/models";
import { auth } from "../lib/firebase";
import { api, apiDelete, apiGet, apiPost } from "./api";
import { getDeviceId } from "./device";
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
  /** A week number with no semester start in the document: undated until the user picks the date. */
  needsSemesterStart?: boolean;
  rangeStart?: string | null;
  yearInferred?: boolean;
  aiOnly?: boolean;
  aiAgrees?: boolean;
  /** Added from this file before, then deleted: offered again, unticked. */
  removedSinceUpload?: boolean;
  created?: boolean;
  existing?: boolean;
  /** DOC_EVIDENCE: the AI's source line was found in the text and gives the date. Absent when the check is off. */
  verified?: boolean;
  /** DOC_EVIDENCE: the document line the item came from. */
  evidence?: string | null;
  /** DOC_AGREE: two AI readers found it. */
  modelsAgree?: boolean;
};

/** DOC_ROUTING document types (the server's DOC_KINDS). */
export const DOC_KINDS = ["timetable", "schedule", "notice", "assignment", "other"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export type ExtractedSchedule = {
  index: number;
  title: string;
  daysOfWeek: number[];
  time: string | null;
  durationMinutes: number | null;
  room: string | null;
  /** Read from an image and not shaped like a room code: the review row asks the user to check it. */
  roomCheck?: boolean;
  instructor: string | null;
  confidence: number;
  source: string;
  created?: boolean;
  existing?: boolean;
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
  /** The same file was read within the last 24 h: this is that saved result (nothing was created again). */
  reused?: boolean;
  document: { id: string; fileName: string; docType: DocType; ocrConfidence: number | null; createdAt: string };
  extracted: {
    deadlines: ExtractedDeadline[];
    schedules: ExtractedSchedule[];
    course: CourseInfo;
    ocrConfidence: number;
    warning: string | null;
    needsLanguage: boolean;
    method: string;
    /** DOC_ROUTING: the detected (or picked) type; absent when routing is off. */
    kind?: { kind: DocKind; confidence: number; via: "rules" | "model" | "user" };
  };
  createdTasks: Task[];
  createdRoutines: Array<{ id: string; title: string }>;
  textPreview: string;
  /** DOC_FALLBACK_UI: the extracted (masked) text for "See what was read"; absent when that view is off. */
  text?: string;
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
  // Plain XMLHttpRequest: it's the only client here that sends React Native's { uri, name, type } file parts.
  // axios mangles them, and Expo's global fetch throws "Unsupported FormDataPart implementation".
  // No Content-Type header — the native layer adds the multipart boundary.
  const token = await auth.currentUser?.getIdToken();
  const deviceId = await getDeviceId();
  const send = () => new Promise<{ success: boolean; data: ProcessResult; message?: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${api.defaults.baseURL}/documents`);
    // The server spends at most 150 s on a document (DOCUMENT_TIME_LIMIT_MS: OCR + AI) and then answers with
    // what it found; 4 minutes also covers a 10 MB upload on a slow connection.
    xhr.timeout = 240000;
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("X-Timezone", Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    xhr.setRequestHeader("X-Device-Id", deviceId);
    xhr.upload.onprogress = (e) => {
      if (onProgress && e.total) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      try {
        resolve(JSON.parse(xhr.responseText));
      } catch {
        reject(new Error(`Upload failed (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("You're offline or the server can't be reached."));
    xhr.ontimeout = () => reject(new Error("Upload timed out — please retry."));
    xhr.send(form);
  });
  // A pooled connection the server already dropped (e.g. after a restart) fails instantly with
  // "Stream Closed" — OkHttp can't replay a file body. One fresh attempt goes through.
  let body: Awaited<ReturnType<typeof send>>;
  try {
    body = await send();
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Upload timed out")) throw e;
    onProgress?.(0);
    body = await send();
  }
  if (!body.success) throw new Error(body.message ?? "Upload failed");
  void syncNow();
  scheduleReminderSync();
  return body.data;
}

export async function processText(text: string, docType: DocType, title: string): Promise<ProcessResult> {
  // No OCR for pasted text, but the AI pass can use most of the server's 150 s limit.
  const result = await apiPost<ProcessResult>("/documents/text", { text, docType, title }, { timeout: 180000 });
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
    schedules: Array<{ title: string; daysOfWeek: number[]; time: string | null; durationMinutes: number | null; location?: string | null }>;
  },
): Promise<{ tasks: Task[]; routines: Array<{ id: string; title: string }> }> {
  const result = await apiPost<{ tasks: Task[]; routines: Array<{ id: string; title: string }> }>(`/documents/${id}/apply`, items);
  void syncNow();
  scheduleReminderSync();
  return result;
}

/** DOC_FALLBACK_UI "Pick lines": review items from lines of the document's text (nothing is created). */
export function pickLines(id: string, lines: string[]): Promise<{ deadlines: ExtractedDeadline[] }> {
  return apiPost<{ deadlines: ExtractedDeadline[] }>(`/documents/${id}/pick-lines`, { lines });
}

/** DOC_ROUTING "Wrong type?": the document read again as `kind` (nothing is created). */
export function reextractDocument(id: string, kind: DocKind): Promise<{ extracted: ProcessResult["extracted"] }> {
  return apiPost<{ extracted: ProcessResult["extracted"] }>(`/documents/${id}/reextract`, { kind });
}
