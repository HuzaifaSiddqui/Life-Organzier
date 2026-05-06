import {
  TaskStatus,
  type Priority,
  type Task,
  type TaskSource,
} from "@prisma/client";
import { prisma } from "../../config/db.js";

export async function listTasksForUser(userId: string): Promise<Task[]> {
  return prisma.task.findMany({
    where: { userId, status: { not: TaskStatus.DELETED } },
    orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
  });
}

export async function getTaskForUser(
  userId: string,
  taskId: string
): Promise<Task | null> {
  return prisma.task.findFirst({
    where: { id: taskId, userId, status: { not: TaskStatus.DELETED } },
  });
}

export async function createTask(input: {
  userId: string;
  title: string;
  description?: string | null;
  dueDate?: Date | null;
  dueTime?: string | null;
  priority: Priority;
  category?: string | null;
  status: TaskStatus;
  source: TaskSource;
  confidence?: number | null;
}): Promise<Task> {
  return prisma.task.create({ data: input });
}

export async function updateTask(
  userId: string,
  taskId: string,
  data: Partial<{
    title: string;
    description: string | null;
    dueDate: Date | null;
    dueTime: string | null;
    priority: Priority;
    category: string | null;
    status: TaskStatus;
  }>
): Promise<Task | null> {
  const existing = await prisma.task.findFirst({
    where: { id: taskId, userId, status: { not: TaskStatus.DELETED } },
  });
  if (!existing) return null;
  return prisma.task.update({ where: { id: taskId }, data });
}

export async function setTaskStatus(
  userId: string,
  taskId: string,
  status: TaskStatus
): Promise<Task | null> {
  const existing = await prisma.task.findFirst({
    where: { id: taskId, userId },
  });
  if (!existing) return null;
  return prisma.task.update({ where: { id: taskId }, data: { status } });
}

export async function deleteTask(userId: string, taskId: string): Promise<boolean> {
  const result = await prisma.task.deleteMany({ where: { id: taskId, userId } });
  return result.count > 0;
}
