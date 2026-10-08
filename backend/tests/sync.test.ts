import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Priority, TaskSource, TaskStatus } from "@prisma/client";
import { prisma } from "../src/config/db.js";
import { mergeFields, mutationAction } from "../src/modules/sync/syncRoutes.js";
import { createTask } from "../src/modules/tasks/taskService.js";

const base = { title: "Essay", priority: "MEDIUM", dueTime: "5 PM", category: "Academic" };
const t = (iso: string) => new Date(iso);

test("sync merge: fields changed on only one side are all kept", () => {
  // Server changed priority since the client's base; client changed the title.
  const current = { ...base, priority: "HIGH" };
  const r = mergeFields({ title: "Final essay" }, base, current, t("2026-10-05T10:00:00Z"), t("2026-10-05T11:00:00Z"));
  assert.deepEqual(r.merged, { title: "Final essay" });
  assert.deepEqual(r.dropped, []);
});

test("sync merge: true conflict — the newer modification wins", () => {
  const current = { ...base, dueTime: "6 PM" }; // server edited dueTime at 11:00
  const olderClient = mergeFields({ dueTime: "9 PM", title: "Essay v2" }, base, current, t("2026-10-05T10:00:00Z"), t("2026-10-05T11:00:00Z"));
  assert.deepEqual(olderClient.merged, { title: "Essay v2" });
  assert.deepEqual(olderClient.dropped, ["dueTime"]);
  assert.equal(olderClient.clientWins, false);

  const newerClient = mergeFields({ dueTime: "9 PM" }, base, current, t("2026-10-05T12:00:00Z"), t("2026-10-05T11:00:00Z"));
  assert.deepEqual(newerClient.merged, { dueTime: "9 PM" });
  assert.equal(newerClient.clientWins, true);
});

test("sync merge: purged base version applies every incoming field", () => {
  const r = mergeFields({ dueTime: "9 PM" }, null, { ...base, dueTime: "6 PM" }, t("2026-10-05T10:00:00Z"), t("2026-10-05T11:00:00Z"));
  assert.deepEqual(r.merged, { dueTime: "9 PM" });
});

test("sync: delete vs update", () => {
  const pending = { status: TaskStatus.PENDING };
  const deleted = { status: TaskStatus.DELETED };
  assert.equal(mutationAction("delete", pending), "delete"); // delete after a server update still deletes
  assert.equal(mutationAction("update", deleted), "keep_deleted"); // update after a delete: deletion stands
  assert.equal(mutationAction("delete", deleted), "already_deleted"); // repeated delete is a no-op
  assert.equal(mutationAction("update", pending), "merge");
  assert.equal(mutationAction("update", null), "reject");
});

// Idempotent create needs the database (unique userId + clientId); skipped when none is reachable (CI).
const dbAvailable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

test("sync: creating with the same clientId twice yields one task", { skip: !dbAvailable && "no database" }, async () => {
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `sync-test-${randomUUID()}@example.test` } });
  try {
    const ctx = { userId: user.id, tz: "Asia/Karachi" };
    const input = { title: "Offline task", priority: Priority.MEDIUM, source: TaskSource.MANUAL, clientId: "local-123" };
    const first = await createTask(ctx, input);
    const second = await createTask(ctx, input);
    assert.equal(second.id, first.id);
    assert.equal(await prisma.task.count({ where: { userId: user.id } }), 1);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test.after(() => prisma.$disconnect());
