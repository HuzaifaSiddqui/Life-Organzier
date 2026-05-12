import { api } from "./api";
import type { ParsedTask, Task } from "../types/models";
import { ymdFromLocalDate } from "../utils/datetimeValidation";

export async function getTasks(): Promise<Task[]> {
  const res = await api.get("/tasks");
  const body = res.data as { success: boolean; data: { tasks: Task[] } };
  if (!body.success) throw new Error("Could not load tasks");
  return body.data.tasks;
}

export async function getTask(id: string): Promise<Task> {
  const res = await api.get(`/tasks/${id}`);
  const body = res.data as { success: boolean; data: { task: Task } };
  if (!body.success) throw new Error("Could not load task");
  return body.data.task;
}

export async function createTask(payload: {
  title: string;
  description?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  priority: Task["priority"];
  category?: string | null;
  status?: Task["status"];
  source: Task["source"];
  confidence?: number | null;
}): Promise<Task> {
  // Axios drops `undefined`; server must receive explicit nulls or dueTime never persists (breaks reminders).
  const requestBody = {
    ...payload,
    dueDate: payload.dueDate ?? null,
    dueTime: payload.dueTime ?? null,
  };
  const res = await api.post("/tasks", requestBody);
  const body = res.data as { success: boolean; data: { task: Task } };
  if (!body.success) throw new Error("Could not create task");
  return body.data.task;
}

export async function updateTask(
  id: string,
  payload: Partial<{
    title: string;
    description: string | null;
    dueDate: string | null;
    dueTime: string | null;
    priority: Task["priority"];
    category: string | null;
    status: Task["status"];
  }>
): Promise<Task> {
  const normalized = { ...payload };
  if ("dueDate" in payload) normalized.dueDate = payload.dueDate ?? null;
  if ("dueTime" in payload) normalized.dueTime = payload.dueTime ?? null;

  const res = await api.put(`/tasks/${id}`, normalized);
  const body = res.data as { success: boolean; data: { task: Task } };
  if (!body.success) throw new Error("Could not update task");
  return body.data.task;
}

export async function deleteTask(id: string): Promise<void> {
  const res = await api.delete(`/tasks/${id}`);
  const body = res.data as { success: boolean };
  if (!body.success) throw new Error("Could not delete task");
}

export async function parseTaskText(text: string): Promise<ParsedTask> {
  const now = new Date();
  const res = await api.post("/parser/task", {
    text,
    clientTodayYmd: ymdFromLocalDate(now),
    clientNowIso: now.toISOString(),
    clientTimezoneOffsetMinutes: now.getTimezoneOffset(),
  });
  const body = res.data as { success: boolean; data: ParsedTask };
  if (!body.success) throw new Error("Could not parse task");
  return body.data;
}
