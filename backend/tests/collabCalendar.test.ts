import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SharedTaskKind, TaskStatus, type User } from "@prisma/client";
import { prisma } from "../src/config/db.js";
import {
  acceptSharedTask,
  cancelSharedTask,
  createSharedTask,
  leaveSharedTask,
  rejectSharedTask,
  removeMember,
  requestConnection,
  respondConnection,
  updateSharedTask,
} from "../src/modules/collab/collabService.js";
import { setPushProvider } from "../src/modules/push/pushService.js";
import { dbAvailable, TZ } from "./fixtures.js";

/**
 * CALENDAR_SYNC × COLLAB_TASKS, server side: the phone's calendar mirrors the tasks the sync pull sends it
 * (mobile/src/utils/calendarSync.ts; the phone side is mobile/src/utils/__tests__/calendarCollab.test.ts). These checks
 * pin what that pull holds for the owner and the recipient at each step of a share.
 */
const skip = !dbAvailable && "no database";
const FRIDAY = new Date("2026-11-13T00:00:00Z");

async function person(name: string): Promise<User> {
  const tag = randomUUID().slice(0, 8);
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `${name}-${tag}@example.test`, username: `${name}_${tag}`.slice(0, 20) } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ } });
  return user;
}

async function connect(a: User, b: User): Promise<void> {
  const r = await requestConnection(a, b.id);
  await respondConnection(b, r.connectionId, true);
}

/** What GET/POST /api/sync sends: the full pull (no `since`), or the changes after `since`. */
const pull = (u: User, since?: Date) =>
  prisma.task.findMany({ where: { userId: u.id, ...(since ? { updatedAt: { gt: since } } : { status: { not: TaskStatus.DELETED } }) } });

const details = { title: "Lab report", priority: "MEDIUM" as const, dueDate: FRIDAY, dueTime: "3 PM" };

test("collab × calendar (server): 'only for them' puts nothing on the owner's pull; an accepted share is a dated copy for the recipient", { skip }, async () => {
  setPushProvider({ send: async (m) => m.map(() => ({ id: randomUUID() })), receipts: async () => ({}) });
  const owner = await person("cco");
  const sana = await person("ccs");
  await connect(owner, sana);

  const assign = await createSharedTask(owner, TZ, { ...details, kind: SharedTaskKind.ASSIGN, memberIds: [sana.id] });
  assert.equal(assign.ownerTask, null);
  assert.equal((await pull(owner)).length, 0, "only for them: no task, so no event, for the owner");
  assert.equal((await pull(sana)).length, 0, "nothing for the recipient until they accept");

  await acceptSharedTask(sana, TZ, assign.shared.id);
  const copy = (await pull(sana))[0];
  assert.equal(copy.sharedTaskId, assign.shared.id);
  assert.equal(copy.dueTime, "3 PM");
  assert.equal(copy.dueDate?.toISOString(), FRIDAY.toISOString(), "dated: the phone makes an event for it");

  const together = await createSharedTask(owner, TZ, { ...details, title: "Slides", kind: SharedTaskKind.COLLAB, memberIds: [sana.id] });
  assert.ok(together.ownerTask?.dueDate, "together: the owner's own copy is dated (an event in the owner's calendar)");
});

test("collab × calendar (server): removed, left or cancelled — the recipient's copy stays as an ordinary task and reaches the next incremental sync; declining a change deletes it", { skip }, async () => {
  setPushProvider({ send: async (m) => m.map(() => ({ id: randomUUID() })), receipts: async () => ({}) });
  const owner = await person("cce");
  const users = { removed: await person("ccr"), left: await person("ccl"), cancelled: await person("ccc"), declined: await person("ccd") };
  for (const u of Object.values(users)) await connect(owner, u);
  const share = async (u: User) => {
    const s = await createSharedTask(owner, TZ, { ...details, kind: SharedTaskKind.ASSIGN, memberIds: [u.id] });
    await acceptSharedTask(u, TZ, s.shared.id);
    return s.shared.id;
  };
  const ids = { removed: await share(users.removed), left: await share(users.left), cancelled: await share(users.cancelled), declined: await share(users.declined) };
  const since = new Date();
  await new Promise((r) => setTimeout(r, 5));

  await removeMember(owner, ids.removed, users.removed.id);
  await leaveSharedTask(users.left, ids.left);
  await cancelSharedTask(owner, ids.cancelled);
  for (const who of ["removed", "left", "cancelled"] as const) {
    const changed = await pull(users[who], since);
    assert.equal(changed.length, 1, `${who}: the copy is in the next incremental sync`);
    assert.equal(changed[0].status, TaskStatus.PENDING, `${who}: still the recipient's task`);
    assert.equal(changed[0].sharedTaskId, null, `${who}: no longer linked to the shared task`);
  }

  // The owner changes a detail, the member declines the change: their copy is deleted (and so is its event).
  await updateSharedTask(owner, TZ, ids.declined, { dueTime: "5 PM" });
  await rejectSharedTask(users.declined, TZ, ids.declined);
  const gone = await pull(users.declined, since);
  assert.equal(gone[0]?.status, TaskStatus.DELETED, "declined after a change: the copy arrives as deleted");
});
