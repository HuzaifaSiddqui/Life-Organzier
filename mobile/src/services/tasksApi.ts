import type { Priority, ReminderMode, Task, TaskSource, TaskStatus, TaskType } from "../types/models";
import { apiGet, apiPost, getApiErrorMessage } from "./api";
import { enqueue, isLocalId, newId, readTasks, serverIdFor, syncNow, writeTasks } from "./syncEngine";
import { scheduleReminderSync } from "./reminders";

export type TaskInput = {
  title: string;
  description?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  priority: Priority;
  category?: string | null;
  status?: TaskStatus;
  source: TaskSource;
  confidence?: number | null;
  parentTaskId?: string | null;
  progress?: number;
  durationMinutes?: number | null;
  difficulty?: number | null;
  taskType?: TaskType;
  tags?: string[] | null;
  locationContext?: string | null;
  reminderMinutes?: number | null;
  reminderMode?: ReminderMode;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  archived?: boolean;
};

export type TaskChanges = Partial<Omit<TaskInput, "source">>;

/** Kept for AuthContext: flush pending offline changes. */
export async function syncPendingTasks(): Promise<void> {
  await syncNow();
}

function visible(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.status !== "DELETED");
}

/** Local deadline instant for optimistic tasks (server recomputes authoritatively). */
function localDueAt(dueDate: string | null | undefined, dueTime: string | null | undefined): string | null {
  if (!dueDate) return null;
  const d = new Date(dueDate);
  if (Number.isNaN(d.getTime())) return null;
  const m = (dueTime ?? "").trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (m) {
    let h = Number(m[1]);
    if (m[3]?.toLowerCase() === "pm" && h < 12) h += 12;
    if (m[3]?.toLowerCase() === "am" && h === 12) h = 0;
    d.setHours(h, Number(m[2] ?? 0), 0, 0);
  } else {
    d.setHours(23, 59, 0, 0);
  }
  return d.toISOString();
}

export async function getTasks(): Promise<Task[]> {
  await syncNow();
  return visible(await readTasks());
}

export async function getCachedTasks(): Promise<Task[]> {
  return visible(await readTasks());
}

export async function getTask(id: string): Promise<{ task: Task; subtasks: Task[]; parent: { id: string; title: string } | null; canUndo: boolean }> {
  if (!isLocalId(id)) {
    try {
      return await apiGet(`/tasks/${id}`);
    } catch (error) {
      const cached = (await readTasks()).find((t) => t.id === id);
      if (!cached) throw new Error(getApiErrorMessage(error, "Could not load task"));
    }
  }
  const all = await readTasks();
  const task = all.find((t) => t.id === id);
  if (!task) throw new Error("Task not found");
  return {
    task,
    subtasks: all.filter((t) => t.parentTaskId === id && t.status !== "DELETED"),
    parent: task.parentTaskId ? { id: task.parentTaskId, title: all.find((t) => t.id === task.parentTaskId)?.title ?? "" } : null,
    canUndo: false,
  };
}

export async function createTask(input: TaskInput): Promise<Task> {
  const localId = newId("local");
  const now = new Date().toISOString();
  const optimistic: Task = {
    id: localId,
    userId: "local",
    title: input.title,
    description: input.description ?? null,
    dueDate: input.dueDate ?? null,
    dueTime: input.dueTime ?? null,
    dueAt: localDueAt(input.dueDate, input.dueTime),
    priority: input.priority,
    category: input.category ?? null,
    status: input.status ?? "PENDING",
    source: input.source,
    confidence: input.confidence ?? null,
    createdAt: now,
    updatedAt: now,
    parentTaskId: input.parentTaskId ?? null,
    progress: input.progress ?? 0,
    durationMinutes: input.durationMinutes ?? null,
    difficulty: input.difficulty ?? null,
    taskType: input.taskType ?? "FLEXIBLE",
    tags: input.tags ?? null,
    locationContext: input.locationContext ?? null,
    reminderMinutes: input.reminderMinutes ?? null,
    reminderMode: input.reminderMode ?? "ADAPTIVE",
    scheduledStart: input.scheduledStart ?? null,
    scheduledEnd: input.scheduledEnd ?? null,
    version: 1,
    pendingSync: true,
  };
  await writeTasks([optimistic, ...(await readTasks())]);
  await enqueue({ op: "create", localId, changes: { ...input } });
  await syncNow();
  scheduleReminderSync();
  const all = await readTasks();
  // After a successful sync the optimistic copy is replaced by the server task.
  const serverId = serverIdFor(localId);
  return all.find((t) => t.id === (serverId ?? localId)) ?? optimistic;
}

export async function updateTask(id: string, changes: TaskChanges): Promise<Task> {
  const all = await readTasks();
  const existing = all.find((t) => t.id === id);
  if (!existing) throw new Error("Task not found");
  const normalized: Record<string, unknown> = { ...changes };
  if ("dueDate" in changes) normalized.dueDate = changes.dueDate ?? null;
  if ("dueTime" in changes) normalized.dueTime = changes.dueTime ?? null;
  const updated: Task = {
    ...existing,
    ...(normalized as Partial<Task>),
    dueAt: "dueDate" in changes || "dueTime" in changes ? localDueAt(normalized.dueDate as string | null, (normalized.dueTime as string | null) ?? existing.dueTime) : existing.dueAt,
    progress: changes.status === "COMPLETED" ? 100 : (changes.progress ?? existing.progress),
    status: changes.progress === 100 ? "COMPLETED" : (changes.status ?? existing.status),
    updatedAt: new Date().toISOString(),
    pendingSync: true,
  };
  await writeTasks(all.map((t) => (t.id === id ? updated : t)));
  await enqueue(isLocalId(id) ? { op: "update", taskId: id, changes: normalized } : { op: "update", taskId: id, baseVersion: existing.version, changes: normalized });
  await syncNow();
  scheduleReminderSync();
  return (await readTasks()).find((t) => t.id === id) ?? updated;
}

export async function setTaskStatus(id: string, status: TaskStatus): Promise<Task> {
  return updateTask(id, { status });
}

export async function deleteTask(id: string): Promise<void> {
  const all = await readTasks();
  await writeTasks(all.map((t) => (t.id === id ? { ...t, status: "DELETED", deletedAt: new Date().toISOString(), pendingSync: true } : t)));
  await enqueue({ op: "delete", taskId: id });
  await syncNow();
  scheduleReminderSync();
}

export async function restoreTask(id: string): Promise<Task> {
  try {
    const { task } = await apiPost<{ task: Task }>(`/tasks/${id}/restore`);
    const all = await readTasks();
    await writeTasks([task, ...all.filter((t) => t.id !== id)]);
    scheduleReminderSync();
    return task;
  } catch (error) {
    throw new Error(getApiErrorMessage(error, "Could not restore task"));
  }
}

export async function undoTaskEdit(id: string): Promise<Task> {
  try {
    const { task } = await apiPost<{ task: Task }>(`/tasks/${id}/undo`);
    const all = await readTasks();
    await writeTasks(all.map((t) => (t.id === id ? task : t)));
    scheduleReminderSync();
    return task;
  } catch (error) {
    throw new Error(getApiErrorMessage(error, "Could not undo"));
  }
}

export async function splitTask(id: string, parts?: Array<{ title: string; durationMinutes?: number | null }>): Promise<{ task: Task; subtasks: Task[] }> {
  try {
    const result = await apiPost<{ task: Task; subtasks: Task[] }>(`/tasks/${id}/split`, parts?.length ? { parts } : { count: 3 }, { timeout: 60000 });
    await syncNow();
    return result;
  } catch (error) {
    throw new Error(getApiErrorMessage(error, "Could not split task"));
  }
}

export async function getDeletedTasks(): Promise<Task[]> {
  try {
    return (await apiGet<{ tasks: Task[] }>("/tasks/deleted")).tasks;
  } catch {
    return (await readTasks()).filter((t) => t.status === "DELETED");
  }
}

export async function suggestForTitle(text: string): Promise<{ category: string | null; tags: string[] }> {
  try {
    return await apiPost<{ category: string | null; tags: string[] }>("/tasks/suggest", { text });
  } catch {
    return { category: null, tags: [] };
  }
}

export async function suggestSlot(id: string): Promise<{ start: string; end: string; reason: string } | null> {
  try {
    return (await apiGet<{ slot: { start: string; end: string; reason: string } | null }>(`/tasks/${id}/suggest-slot`)).slot;
  } catch {
    return null;
  }
}
