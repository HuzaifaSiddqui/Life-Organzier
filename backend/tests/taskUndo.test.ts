import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Priority, SharedTaskKind, TaskSource, TaskStatus, type User } from "@prisma/client";
import { prisma } from "../src/config/db.js";
import { setMailTransport } from "../src/modules/collab/collabEmail.js";
import { acceptSharedTask, createSharedTask, getSharedTask, requestConnection, respondConnection } from "../src/modules/collab/collabService.js";
import { setPushProvider } from "../src/modules/push/pushService.js";
import { createTask, updateTask } from "../src/modules/tasks/taskService.js";
import { dbAvailable, TZ } from "./fixtures.js";

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

async function person(name: string): Promise<User> {
  const tag = randomUUID().slice(0, 8);
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `${name}-${tag}@example.test`, username: `${name}_${tag}`.slice(0, 20) } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ } });
  return user;
}

/**
 * Edge case, documented (no behaviour change): "Do it together", Sana swipes Done, the owner moves the shared
 * progress on, then Sana taps Undo. Undo restores Sana's own snapshot (in progress, 40 %); as a newer progress
 * write it reaches every copy, so the owner's later 60 % is overwritten (last writer wins, as for any progress).
 */
test("undo on a 'Do it together' task: Sana's snapshot comes back and, as the newest write, reaches every copy", { skip }, async () => {
  setPushProvider({ send: async (m) => m.map(() => ({ id: randomUUID() })), receipts: async () => ({}) });
  setMailTransport(null);
  const owner = await person("uo");
  const sana = await person("us");
  try {
    const r = await requestConnection(owner, sana.id);
    await respondConnection(sana, r.connectionId, true);
    const { shared, ownerTask } = await createSharedTask(owner, TZ, { kind: SharedTaskKind.COLLAB, memberIds: [sana.id], title: "Report", priority: "MEDIUM" });
    const sanaTask = (await acceptSharedTask(sana, TZ, shared.id)).task;
    const get = (id: string) => prisma.task.findUniqueOrThrow({ where: { id } });

    await updateTask({ userId: sana.id, tz: TZ }, sanaTask.id, { progress: 40 });
    const before = await get(sanaTask.id);
    await updateTask({ userId: sana.id, tz: TZ }, sanaTask.id, { status: TaskStatus.COMPLETED }); // swipe Done: personal
    assert.equal((await get(ownerTask!.id)).progress, 40, "done stays personal");
    await updateTask({ userId: owner.id, tz: TZ }, ownerTask!.id, { progress: 60 }); // owner moves on
    assert.equal((await get(sanaTask.id)).progress, 100, "a done copy isn't moved by others' progress");
    assert.equal((await getSharedTask(owner.id, shared.id)).progress, 60);

    await updateTask({ userId: sana.id, tz: TZ }, sanaTask.id, { status: before.status, progress: before.progress }); // Undo
    const s = await get(sanaTask.id);
    const o = await get(ownerTask!.id);
    assert.deepEqual([s.status, s.progress], [TaskStatus.IN_PROGRESS, 40]);
    assert.equal(o.progress, 40, "the owner's newer 60 % is overwritten by the undo (last writer wins)");
    assert.equal(o.progressUpdatedBy, `@${sana.username}`);
    assert.equal((await getSharedTask(owner.id, shared.id)).progress, 40);
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, sana.id] } } });
  }
});
