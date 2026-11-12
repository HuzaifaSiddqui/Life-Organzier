import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Priority, TaskSource, TaskStatus } from "@prisma/client";
import { prisma } from "../src/config/db.js";
import { createTask, updateTask } from "../src/modules/tasks/taskService.js";
import { dbAvailable } from "./fixtures.js";

/** Swipe Undo sends the previous status AND progress; the server must keep that progress exactly. Throwaway user. */
async function withUser(fn: (ctx: { userId: string; tz: string }) => Promise<void>) {
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  try {
    await fn({ userId: user.id, tz: "Asia/Karachi" });
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
}

const skip = !dbAvailable && "no database";

test("undo of a Done swipe: reopening with the previous progress keeps it (0 %, 40 %)", { skip }, async () => {
  await withUser(async (ctx) => {
    for (const [status, progress] of [[TaskStatus.PENDING, 0], [TaskStatus.IN_PROGRESS, 40]] as const) {
      const t = await createTask(ctx, { title: `Undo ${progress}`, priority: Priority.MEDIUM, source: TaskSource.MANUAL });
      if (progress) await updateTask(ctx, t.id, { status, progress });
      await updateTask(ctx, t.id, { status: TaskStatus.COMPLETED });
      const back = await updateTask(ctx, t.id, { status, progress });
      assert.equal(back?.status, status);
      assert.equal(back?.progress, progress);
      assert.equal(back?.completedAt, null);
    }
  });
});

test("reopening without a progress still keeps min(progress, 75), as before", { skip }, async () => {
  await withUser(async (ctx) => {
    const t = await createTask(ctx, { title: "Reopen", priority: Priority.MEDIUM, source: TaskSource.MANUAL });
    await updateTask(ctx, t.id, { status: TaskStatus.COMPLETED });
    assert.equal((await updateTask(ctx, t.id, { status: TaskStatus.PENDING }))?.progress, 75);
  });
});
