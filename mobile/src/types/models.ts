export type Priority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
export type TaskStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "DELETED";
export type TaskSource = "MANUAL" | "CHAT" | "VOICE";

export type Task = {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  dueTime: string | null;
  priority: Priority;
  category: string | null;
  status: TaskStatus;
  source: TaskSource;
  confidence: number | null;
  createdAt: string;
  updatedAt: string;
};

export type User = {
  id: string;
  firebaseUid: string;
  email: string;
  displayName: string | null;
  photoUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ParsedTask = {
  title: string;
  dueDateText: string | null;
  dueTime: string | null;
  priority: Priority;
  category: string | null;
  confidence: number;
  needsConfirmation: boolean;
  dueDateIso: string | null;
};

export type ApiSuccess<T> = { success: true; message: string; data: T };
export type ApiError = { success: false; message: string; error: string };
