import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SharedMemberStatus, SharedTaskKind, TaskStatus, type User } from "@prisma/client";
import { prisma } from "../src/config/db.js";
import { backgroundSettled } from "../src/lib/background.js";
import {
  changedAgreedFields,
  isUnsettled,
  maskEmail,
  normalizeUsername,
  participantState,
  proposedChange,
  searchTerm,
} from "../src/modules/collab/collabRules.js";
import {
  acceptSharedTask,
  cancelSharedTask,
  createSharedTask,
  getSharedTask,
  listConnections,
  listNotices,
  listSharedTasks,
  rejectSharedTask,
  removeConnection,
  requestConnection,
  resendSharedTask,
  respondConnection,
  searchUsers,
  setUsername,
  updateSharedTask,
} from "../src/modules/collab/collabService.js";
import { setPushProvider, type PushMessage } from "../src/modules/push/pushService.js";
import { softDeleteTask, updateTask } from "../src/modules/tasks/taskService.js";
import { dbAvailable, TZ } from "./fixtures.js";

const skip = !dbAvailable && "no database";

/* ------------------------------------------------------------------ pure */

test("collab rules: usernames, masked emails, search text", () => {
  assert.equal(normalizeUsername(" @Ali_Khan "), "ali_khan");
  assert.equal(normalizeUsername("ab"), null, "too short");
  assert.equal(normalizeUsername("ali khan"), null, "no spaces");
  assert.equal(normalizeUsername("a".repeat(21)), null, "too long");
  assert.equal(maskEmail("ali.khan@gmail.com"), "a•••@gmail.com");
  assert.deepEqual(searchTerm(" A "), { text: "a", usernameOnly: false }, "one letter is enough");
  assert.deepEqual(searchTerm("@Ali"), { text: "ali", usernameOnly: true });
  assert.equal(searchTerm("  "), null);
  assert.equal(searchTerm("@"), null);
});

test("collab rules: a participant's state, and what is still open between two people", () => {
  const m = (status: SharedMemberStatus, reapproval = false) => ({ status, reapproval });
  assert.equal(participantState(m(SharedMemberStatus.PENDING), null), "waiting");
  assert.equal(participantState(m(SharedMemberStatus.PENDING, true), TaskStatus.PENDING), "changed", "asked again after an owner change");
  assert.equal(participantState(m(SharedMemberStatus.REJECTED), null), "declined");
  assert.equal(participantState(m(SharedMemberStatus.ACCEPTED), TaskStatus.PENDING), "accepted");
  assert.equal(participantState(m(SharedMemberStatus.ACCEPTED), TaskStatus.IN_PROGRESS), "in_progress");
  assert.equal(participantState(m(SharedMemberStatus.ACCEPTED), TaskStatus.COMPLETED), "done");
  assert.equal(participantState(m(SharedMemberStatus.ACCEPTED), TaskStatus.DELETED), "removed", "deleted their copy");
  assert.equal(participantState(null, TaskStatus.PENDING), "accepted", "the owner of a task done together");
  assert.equal(isUnsettled(["done", "declined", "removed"]), false);
  assert.equal(isUnsettled(["done", "in_progress"]), true);
  assert.equal(isUnsettled(["waiting"]), true);
});

test("collab rules: agreed fields that changed; a different date/time when accepting", () => {
  const d = new Date("2026-11-10T00:00:00Z");
  assert.deepEqual(changedAgreedFields({ title: "A", dueDate: d, dueTime: "3 PM" }, { title: "A", dueDate: new Date(d), dueTime: "4 PM" }), ["dueTime"]);
  assert.deepEqual(changedAgreedFields({ title: "A" }, { title: undefined, durationMinutes: 60 }), ["durationMinutes"]);
  assert.equal(proposedChange({ dueDate: d, dueTime: "3 PM" }, {}), null);
  assert.equal(proposedChange({ dueDate: d, dueTime: "3 PM" }, { dueDate: new Date(d), dueTime: "3 PM" }), null);
  assert.deepEqual(proposedChange({ dueDate: d, dueTime: "3 PM" }, { dueTime: "5 PM" }), { dueDate: d.toISOString(), dueTime: "5 PM" });
});

/* ------------------------------------------------------------------ database */

const pushes: PushMessage[] = [];

async function person(name: string, displayName?: string): Promise<User> {
  const tag = randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: { firebaseUid: `test-${randomUUID()}`, email: `${name}-${tag}@example.test`, displayName: displayName ?? null, username: `${name}_${tag}`.slice(0, 20) },
  });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ } });
  await prisma.pushToken.create({ data: { userId: user.id, token: `ExponentPushToken[${randomUUID()}]`, platform: "android" } });
  return user;
}

async function connect(a: User, b: User): Promise<string> {
  const r = await requestConnection(a, b.id);
  await respondConnection(b, r.connectionId, true);
  return r.connectionId;
}

const timeline = (u: User) => prisma.task.findMany({ where: { userId: u.id, status: { not: TaskStatus.DELETED } } });
const kinds = async (u: User) => (await listNotices(u.id)).map((n) => n.kind);

test.before(() => {
  setPushProvider({ send: async (msgs) => (pushes.push(...msgs), msgs.map(() => ({ id: randomUUID() }))), receipts: async () => ({}) });
});

test("collab: usernames are unique; live search from the first letter, emails masked unless typed in full", { skip }, async () => {
  const me = await person("srch");
  const sana = await person("sanaz", "Sana Zaidi");
  const taken = sana.username!;
  await assert.rejects(setUsername(me.id, taken), /taken/);
  await assert.rejects(setUsername(me.id, "x"), /3–20/);

  // One letter already searches (other test users share the letter, so only the shape is checked here).
  const byLetter = await searchUsers(me.id, "s");
  assert.ok(byLetter.length > 0 && byLetter.length <= 15, "one letter lists people, at most 15");
  assert.ok(!byLetter.some((u) => u.id === me.id), "never myself");
  assert.ok((await searchUsers(me.id, taken.slice(0, 6))).some((u) => u.id === sana.id), "a username prefix finds her");
  const byName = await searchUsers(me.id, "zai");
  assert.ok(byName.some((u) => u.id === sana.id), "any word of the name");
  const hit = byName.find((u) => u.id === sana.id)!;
  assert.equal(hit.email, maskEmail(sana.email));
  assert.equal(hit.state, "none");
  const exact = (await searchUsers(me.id, sana.email)).find((u) => u.id === sana.id)!;
  assert.equal(exact.email, sana.email, "the whole address typed: shown");
  assert.ok(!(await searchUsers(me.id, "@zai")).some((u) => u.id === sana.id), "@ searches usernames only");
});

test("collab: a request, accepted; asking someone who already asked me connects us", { skip }, async () => {
  const a = await person("reqa");
  const b = await person("reqb");
  const r = await requestConnection(a, b.id);
  assert.equal(r.state, "requested");
  assert.equal((await searchUsers(b.id, a.username!)).find((u) => u.id === a.id)?.state, "incoming");
  assert.deepEqual((await listConnections(b.id)).incoming.map((c) => c.user.id), [a.id]);
  assert.equal((await requestConnection(b, a.id)).state, "connected", "b asking back accepts a's request");
  assert.deepEqual((await listConnections(a.id)).connected.map((c) => c.user.id), [b.id]);
  await backgroundSettled();
  assert.deepEqual(await kinds(b), ["CONNECTION_REQUEST"]);
  assert.deepEqual(await kinds(a), ["CONNECTION_ACCEPTED"]);

  // A declined request is gone and can be sent again.
  const c = await person("reqc");
  const r2 = await requestConnection(a, c.id);
  await respondConnection(c, r2.connectionId, false);
  assert.equal((await requestConnection(a, c.id)).state, "requested");
});

test("collab: only connected people can be mentioned", { skip }, async () => {
  const a = await person("nca");
  const b = await person("ncb");
  await requestConnection(a, b.id); // not accepted yet
  await assert.rejects(createSharedTask(a, TZ, { kind: SharedTaskKind.COLLAB, memberIds: [b.id], title: "Notes", priority: "MEDIUM" }), /accepted your request/);
});

test("collab: a task done together by three — nothing on a member's timeline until they accept; each finishes their own part", { skip }, async () => {
  const owner = await person("own");
  const b = await person("memb");
  const c = await person("memc");
  await connect(owner, b);
  await connect(owner, c);
  const due = new Date("2026-11-20T00:00:00Z");

  const { shared, ownerTask } = await createSharedTask(owner, TZ, { kind: SharedTaskKind.COLLAB, memberIds: [b.id, c.id], title: "Group report", priority: "HIGH", dueDate: due, dueTime: "3 PM", durationMinutes: 120 });
  assert.ok(ownerTask, "the owner's own copy is on their timeline at once");
  assert.equal(ownerTask.sharedTaskId, shared.id);
  assert.equal((await timeline(b)).length, 0, "not on b's timeline before accepting");
  assert.deepEqual(shared.participants.map((p) => p.state), ["accepted", "waiting", "waiting"]);
  assert.deepEqual((await listSharedTasks(b.id)).cards.map((s) => s.id), [shared.id], "b has a card");

  const { task: bTask } = await acceptSharedTask(b, TZ, shared.id);
  assert.equal(bTask.title, "Group report");
  assert.equal(bTask.dueTime, "3 PM");
  assert.equal(bTask.sharedTaskId, shared.id);
  assert.equal((await timeline(b)).length, 1);
  // c accepts for a different time: their copy uses it and the owner is told.
  const { task: cTask, shared: afterC } = await acceptSharedTask(c, TZ, shared.id, { dueTime: "6 PM" });
  assert.equal(cTask.dueTime, "6 PM");
  assert.deepEqual(afterC.participants.find((p) => p.user.id === c.id)?.proposedChange, { dueDate: due.toISOString(), dueTime: "6 PM" });

  // b finishes their part: everyone sees it, c's part is still open; owner and c are told.
  await updateTask({ userId: b.id, tz: TZ }, bTask.id, { status: TaskStatus.COMPLETED });
  const seen = await getSharedTask(c.id, shared.id);
  assert.deepEqual(seen.participants.map((p) => [p.user.id, p.state]), [[owner.id, "accepted"], [b.id, "done"], [c.id, "accepted"]]);
  await backgroundSettled();
  assert.ok((await kinds(owner)).includes("TASK_TIME_CHANGED"));
  assert.ok((await kinds(owner)).includes("TASK_COMPLETED"));
  assert.ok((await kinds(c)).includes("TASK_COMPLETED"));
  assert.ok(!(await kinds(b)).includes("TASK_COMPLETED"), "not told about their own completion");
  assert.ok(pushes.some((p) => p.data?.type === "collab"));
});

test("collab: assign — on the member's timeline only; the owner tracks the status", { skip }, async () => {
  const owner = await person("asg");
  const b = await person("asgb");
  await connect(owner, b);
  const { shared, ownerTask } = await createSharedTask(owner, TZ, { kind: SharedTaskKind.ASSIGN, memberIds: [b.id], title: "Print slides", priority: "MEDIUM" });
  assert.equal(ownerTask, null);
  assert.equal((await timeline(owner)).length, 0, "nothing on the owner's timeline");
  assert.deepEqual((await listSharedTasks(owner.id)).shared.map((s) => s.id), [shared.id], "in the owner's shared list");
  const { task } = await acceptSharedTask(b, TZ, shared.id);
  await updateTask({ userId: b.id, tz: TZ }, task.id, { status: TaskStatus.IN_PROGRESS });
  assert.deepEqual((await getSharedTask(owner.id, shared.id)).participants.map((p) => p.state), ["in_progress"]);
});

test("collab: the owner changes the time — accepted members must accept again; their copy keeps the old time until then", { skip }, async () => {
  const owner = await person("chg");
  const b = await person("chgb");
  const c = await person("chgc");
  await connect(owner, b);
  await connect(owner, c);
  const { shared, ownerTask } = await createSharedTask(owner, TZ, { kind: SharedTaskKind.COLLAB, memberIds: [b.id, c.id], title: "Lab prep", priority: "MEDIUM", dueTime: "3 PM", dueDate: new Date("2026-11-21T00:00:00Z") });
  const { task: bTask } = await acceptSharedTask(b, TZ, shared.id);
  const { task: cTask } = await acceptSharedTask(c, TZ, shared.id);

  // A priority change is the owner's own business: nobody is asked again.
  await updateSharedTask(owner, TZ, shared.id, { priority: "URGENT" });
  assert.equal((await getSharedTask(b.id, shared.id)).myStatus, SharedMemberStatus.ACCEPTED);

  const changed = await updateSharedTask(owner, TZ, shared.id, { dueTime: "5 PM" });
  assert.equal(changed.revision, 2);
  assert.deepEqual(changed.participants.map((p) => p.state), ["accepted", "changed", "changed"]);
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: ownerTask!.id } })).dueTime, "5 PM", "owner's copy follows");
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: bTask.id } })).dueTime, "3 PM", "b's copy waits for b");
  assert.deepEqual((await listSharedTasks(b.id)).cards.map((s) => [s.id, s.reapproval]), [[shared.id, true]]);

  const { task: bAgain } = await acceptSharedTask(b, TZ, shared.id);
  assert.equal(bAgain.id, bTask.id, "the same copy, updated");
  assert.equal(bAgain.dueTime, "5 PM");
  await rejectSharedTask(c, TZ, shared.id);
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: cTask.id } })).status, TaskStatus.DELETED, "declining the change removes c's copy");
  await backgroundSettled();
  assert.ok((await kinds(b)).includes("TASK_CHANGED"));
  assert.ok((await kinds(owner)).includes("TASK_REJECTED"));

  // Editing the owner's own copy is the same as editing the shared task.
  await updateTask({ userId: owner.id, tz: TZ }, ownerTask!.id, { title: "Lab prep (bring kits)" });
  const viaCopy = await getSharedTask(owner.id, shared.id);
  assert.equal(viaCopy.title, "Lab prep (bring kits)");
  assert.equal(viaCopy.participants.find((p) => p.user.id === b.id)?.state, "changed");
  // A member editing their own copy changes only theirs.
  await acceptSharedTask(b, TZ, shared.id);
  await updateTask({ userId: b.id, tz: TZ }, bTask.id, { title: "My lab prep" });
  assert.equal((await getSharedTask(owner.id, shared.id)).title, "Lab prep (bring kits)");
});

test("collab: declined, sent again; the owner can delete their own copy or cancel for everyone", { skip }, async () => {
  const owner = await person("dec");
  const b = await person("decb");
  const c = await person("decc");
  await connect(owner, b);
  await connect(owner, c);
  const { shared, ownerTask } = await createSharedTask(owner, TZ, { kind: SharedTaskKind.COLLAB, memberIds: [b.id, c.id], title: "Poster", priority: "LOW" });
  await rejectSharedTask(b, TZ, shared.id);
  assert.equal((await timeline(b)).length, 0, "declined: never created for b");
  await assert.rejects(acceptSharedTask(b, TZ, shared.id), /already answered/);
  await resendSharedTask(owner, shared.id, b.id);
  assert.equal((await listSharedTasks(b.id)).cards.length, 1, "b has the card again");

  await softDeleteTask({ userId: owner.id, tz: TZ }, ownerTask!.id);
  assert.equal((await getSharedTask(owner.id, shared.id)).cancelled, false, "deleting my copy doesn't cancel it for others");

  await acceptSharedTask(c, TZ, shared.id);
  const cancelled = await cancelSharedTask(owner, shared.id);
  assert.equal(cancelled.cancelled, true);
  assert.equal((await listSharedTasks(b.id)).cards.length, 0, "b's unanswered card is withdrawn");
  assert.equal((await timeline(c)).length, 1, "c keeps the copy they accepted");
  await assert.rejects(acceptSharedTask(b, TZ, shared.id), /cancelled/);
  await backgroundSettled();
  assert.ok((await kinds(c)).includes("TASK_CANCELLED"));
});

test("collab: a connection can't be removed while a shared task between us is waiting or not done", { skip }, async () => {
  const a = await person("rma");
  const b = await person("rmb");
  const id = await connect(a, b);
  const { shared } = await createSharedTask(a, TZ, { kind: SharedTaskKind.COLLAB, memberIds: [b.id], title: "Revise ch. 3", priority: "MEDIUM" });

  let r = await removeConnection(b, id);
  assert.equal(r.removed, false, "card not answered");
  assert.deepEqual(r.removed === false && r.openTasks.map((t) => t.title), ["Revise ch. 3"]);

  const { task: bTask } = await acceptSharedTask(b, TZ, shared.id);
  await updateTask({ userId: b.id, tz: TZ }, bTask.id, { status: TaskStatus.COMPLETED });
  r = await removeConnection(a, id);
  assert.equal(r.removed, false, "b is done but a's own part isn't");

  const aTask = (await timeline(a)).find((t) => t.sharedTaskId === shared.id)!;
  await updateTask({ userId: a.id, tz: TZ }, aTask.id, { status: TaskStatus.COMPLETED });
  assert.equal((await removeConnection(a, id)).removed, true, "all settled");
  assert.equal((await listConnections(b.id)).connected.length, 0);
});

test("collab: only the people on a shared task can see or answer it", { skip }, async () => {
  const owner = await person("prv");
  const b = await person("prvb");
  const stranger = await person("prvx");
  await connect(owner, b);
  const { shared } = await createSharedTask(owner, TZ, { kind: SharedTaskKind.ASSIGN, memberIds: [b.id], title: "Private", priority: "LOW" });
  await assert.rejects(getSharedTask(stranger.id, shared.id), /not found/);
  await assert.rejects(acceptSharedTask(stranger, TZ, shared.id), /not found/);
  await assert.rejects(updateSharedTask(b, TZ, shared.id, { title: "Mine now" }), /not found/, "a member can't edit the shared task");
  await assert.rejects(cancelSharedTask(b, shared.id), /not found/);
});

test("collab routes: 404 while COLLAB_TASKS is off (the app hides the feature); signed-in only when on", async () => {
  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0);
  const port = (server.address() as { port: number }).port;
  const before = process.env.COLLAB_TASKS;
  try {
    process.env.COLLAB_TASKS = "off";
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/collab/me`)).status, 404);
    process.env.COLLAB_TASKS = "on";
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/collab/me`)).status, 401);
  } finally {
    process.env.COLLAB_TASKS = before;
    server.close();
  }
});
