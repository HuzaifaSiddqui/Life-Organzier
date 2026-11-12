import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SharedTaskKind, TaskStatus, type User } from "@prisma/client";
import { prisma } from "../src/config/db.js";
import { backgroundSettled } from "../src/lib/background.js";
import { inviteEmailText, INVITE_EMAILS_PER_HOUR, mailSettled, mailStats, queueInviteEmail, setMailTransport } from "../src/modules/collab/collabEmail.js";
import { cleanReason, DECLINE_REASON_MAX, pushText } from "../src/modules/collab/collabRules.js";
import {
  acceptSharedTask,
  createSharedTask,
  getSharedTask,
  listNotices,
  markNoticeRead,
  rejectSharedTask,
  requestConnection,
  respondConnection,
} from "../src/modules/collab/collabService.js";
import { setPushProvider, type PushMessage } from "../src/modules/push/pushService.js";
import { updateTask } from "../src/modules/tasks/taskService.js";
import { dbAvailable, TZ } from "./fixtures.js";

// COLLAB_TASKS notices, decline reasons, shared progress and invitation emails (PR A, items 1, 3, 5, 6, 7).
const skip = !dbAvailable && "no database";
const pushes: PushMessage[] = [];

async function person(name: string, displayName?: string): Promise<User> {
  const tag = randomUUID().slice(0, 8);
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `${name}-${tag}@example.test`, displayName: displayName ?? null, username: `${name}_${tag}`.slice(0, 20) } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ } });
  await prisma.pushToken.create({ data: { userId: user.id, token: `ExponentPushToken[${randomUUID()}]`, platform: "android" } });
  return user;
}

async function connect(a: User, b: User): Promise<void> {
  const r = await requestConnection(a, b.id);
  await respondConnection(b, r.connectionId, true);
}

const pushesTo = async (u: User) => {
  await backgroundSettled();
  const tokens = new Set((await prisma.pushToken.findMany({ where: { userId: u.id } })).map((t) => t.token));
  return pushes.filter((p) => tokens.has(p.to));
};

test.before(() => {
  setPushProvider({ send: async (msgs) => (pushes.push(...msgs), msgs.map(() => ({ id: randomUUID() }))), receipts: async () => ({}) });
  setMailTransport(null); // no email unless a test sets a fake transport
});

test("decline reasons: tags and control characters stripped, length-limited, required", () => {
  assert.equal(cleanReason("  Too   busy\nright now "), "Too busy right now");
  assert.equal(cleanReason("<b>Not</b> my <script>x</script>task"), "Not my x task");
  assert.equal(cleanReason("   "), null);
  assert.equal(cleanReason(""), null);
  assert.equal(cleanReason(42), null);
  assert.equal(cleanReason("x".repeat(DECLINE_REASON_MAX)), "x".repeat(DECLINE_REASON_MAX));
  assert.equal(cleanReason("x".repeat(DECLINE_REASON_MAX + 1)), null);
  assert.match(pushText("TASK_REJECTED", "@sana", "Slides", { reason: "Too busy" }).body, /declined "Slides": Too busy/);
});

test("accept: the owner gets 'X accepted' (notice + push); the member gets 'You joined' in-app only", { skip }, async () => {
  const owner = await person("nao");
  const sana = await person("nas");
  await connect(owner, sana);
  const { shared, ownerTask } = await createSharedTask(owner, TZ, { kind: SharedTaskKind.COLLAB, memberIds: [sana.id], title: "Slides", priority: "MEDIUM" });
  const before = (await pushesTo(sana)).length;
  const { task } = await acceptSharedTask(sana, TZ, shared.id);

  const ownerNotices = await listNotices(owner.id);
  const accepted = ownerNotices.find((n) => n.kind === "TASK_ACCEPTED")!;
  assert.ok(accepted, "owner notice");
  assert.equal(accepted.taskId, ownerTask!.id, "a tap opens the owner's own copy");
  const ownerPush = (await pushesTo(owner)).find((p) => p.title === "Task accepted");
  assert.ok(ownerPush, "owner push");
  assert.equal((ownerPush!.data as { taskId?: string }).taskId, ownerTask!.id);

  const joined = (await listNotices(sana.id)).find((n) => n.kind === "TASK_JOINED")!;
  assert.ok(joined, "member confirmation");
  assert.equal(joined.taskId, task.id);
  assert.equal((await pushesTo(sana)).length, before, "no push for the member's own accept");
});

test("decline: a reason is required; the owner sees it in the notice, the push and on the task", { skip }, async () => {
  const owner = await person("ndo");
  const bilal = await person("ndb");
  await connect(owner, bilal);
  const { shared } = await createSharedTask(owner, TZ, { kind: SharedTaskKind.ASSIGN, memberIds: [bilal.id], title: "Book the lab", priority: "LOW" });
  await assert.rejects(rejectSharedTask(bilal, TZ, shared.id, null, "   "), /short reason/);
  await assert.rejects(rejectSharedTask(bilal, TZ, shared.id, null, "y".repeat(201)), /short reason/);
  const stranger = await person("nds");
  await assert.rejects(rejectSharedTask(stranger, TZ, shared.id, null, ""), /not found/, "no access is a 404, even without a reason");

  await rejectSharedTask(bilal, TZ, shared.id, null, "<i>Exams</i> this week");
  const notice = (await listNotices(owner.id)).find((n) => n.kind === "TASK_REJECTED")!;
  assert.equal((notice.payload as { reason?: string }).reason, "Exams this week");
  assert.ok((await pushesTo(owner)).some((p) => p.body.includes("Exams this week")));
  const view = await getSharedTask(owner.id, shared.id);
  assert.equal(view.participants.find((p) => p.user.id === bilal.id)?.declineReason, "Exams this week");
});

test("progress (done together): a member's update reaches every copy with 'updated by', server time wins; done stays personal; assign untouched", { skip }, async () => {
  const owner = await person("npo");
  const sana = await person("nps", "Sana Zaidi");
  const ali = await person("npa");
  await connect(owner, sana);
  await connect(owner, ali);
  const { shared, ownerTask } = await createSharedTask(owner, TZ, { kind: SharedTaskKind.COLLAB, memberIds: [sana.id, ali.id], title: "Report", priority: "MEDIUM" });
  const sanaTask = (await acceptSharedTask(sana, TZ, shared.id)).task;
  const aliTask = (await acceptSharedTask(ali, TZ, shared.id)).task;

  // Sana → 50 %: the owner's and Ali's copies follow, marked "updated by @sana…".
  await updateTask({ userId: sana.id, tz: TZ }, sanaTask.id, { progress: 50 });
  const o1 = await prisma.task.findUniqueOrThrow({ where: { id: ownerTask!.id } });
  const a1 = await prisma.task.findUniqueOrThrow({ where: { id: aliTask.id } });
  assert.equal(o1.progress, 50);
  assert.equal(a1.progress, 50);
  assert.equal(o1.progressUpdatedBy, `@${sana.username}`);
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: sanaTask.id } })).progressUpdatedBy, null, "my own change isn't 'by' anyone");
  const v1 = await getSharedTask(ali.id, shared.id);
  assert.equal(v1.progress, 50);
  assert.equal(v1.progressBy, `@${sana.username}`);
  assert.ok((await listNotices(ali.id)).some((n) => n.kind === "TASK_PROGRESS" && n.taskId === aliTask.id));

  // The owner → 75 % later: the last write wins everywhere (round trip back to Sana).
  await updateTask({ userId: owner.id, tz: TZ }, ownerTask!.id, { progress: 75 });
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: sanaTask.id } })).progress, 75);
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: sanaTask.id } })).progressUpdatedBy, `@${owner.username}`);
  assert.equal((await getSharedTask(sana.id, shared.id)).progressBy, `@${owner.username}`);

  // Ali finishes his part: that stays personal (no one else is completed).
  await updateTask({ userId: ali.id, tz: TZ }, aliTask.id, { status: TaskStatus.COMPLETED });
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: sanaTask.id } })).status, TaskStatus.IN_PROGRESS);
  assert.equal((await getSharedTask(owner.id, shared.id)).progress, 75);

  // "Only for them": progress never leaves the member's copy.
  const assign = await createSharedTask(owner, TZ, { kind: SharedTaskKind.ASSIGN, memberIds: [sana.id], title: "Print", priority: "LOW" });
  const printTask = (await acceptSharedTask(sana, TZ, assign.shared.id)).task;
  await updateTask({ userId: sana.id, tz: TZ }, printTask.id, { progress: 50 });
  const av = await getSharedTask(owner.id, assign.shared.id);
  assert.equal(av.progress, null);
});

test("email: queued on share and resend, addressed server-side, never blocks the share; opt-out, no SMTP and the hourly limit skip it; no address in logs", { skip }, async () => {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const logs: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    const owner = await person("neo", "Huzaifa S");
    const sana = await person("nes");
    const off = await person("nef");
    await prisma.userSettings.update({ where: { userId: off.id }, data: { emailInvites: false } });
    await connect(owner, sana);
    await connect(owner, off);

    setMailTransport({ sendMail: async (m) => void sent.push(m) });
    const { shared } = await createSharedTask(owner, TZ, { kind: SharedTaskKind.ASSIGN, memberIds: [sana.id, off.id], title: "Poster", priority: "LOW" });
    await mailSettled();
    assert.equal(sent.length, 1, "only the user who didn't opt out");
    assert.equal(sent[0].to, sana.email, "the invited user's own address, read on the server");
    assert.match(sent[0].subject, /assigned a task to you: Poster/);
    assert.match(sent[0].text, /Open Life Organizer/);
    assert.ok(!JSON.stringify(shared).includes(sana.email), "the share's response never carries the address");

    // A failing transport: the share still succeeds; the failure is counted, logged without the address.
    setMailTransport({ sendMail: async () => { throw new Error(`550 mailbox ${sana.email} unavailable`); } });
    const again = await createSharedTask(owner, TZ, { kind: SharedTaskKind.COLLAB, memberIds: [sana.id], title: "Lab", priority: "LOW" });
    assert.ok(again.shared.id);
    await mailSettled();
    assert.equal(mailStats().failed, 1);
    assert.ok(logs.every((l) => !l.includes(sana.email) && !l.includes("@example.test")), "no address in logs");

    // The hourly limit per recipient.
    setMailTransport({ sendMail: async (m) => void sent.push(m) });
    sent.length = 0;
    for (let i = 0; i < INVITE_EMAILS_PER_HOUR + 3; i += 1) queueInviteEmail(sana.id, owner, { title: `T${i}`, kind: "COLLAB" });
    await mailSettled();
    assert.equal(sent.length, INVITE_EMAILS_PER_HOUR);

    // No SMTP configured: nothing is sent.
    setMailTransport(null);
    queueInviteEmail(sana.id, owner, { title: "X", kind: "COLLAB" });
    await mailSettled();
    assert.equal(mailStats().sent, 0);
    assert.equal(mailStats().skipped, 1);
  } finally {
    console.warn = warn;
    setMailTransport(null);
  }
  assert.match(inviteEmailText("@sana", "Slides", "COLLAB").subject, /shared a task with you: Slides/);
});

test("notices: each one marks read on its own; someone else's id marks nothing; a pending card says so", { skip }, async () => {
  const owner = await person("nmo");
  const sana = await person("nms");
  await connect(owner, sana);
  await createSharedTask(owner, TZ, { kind: SharedTaskKind.ASSIGN, memberIds: [sana.id], title: "Invite", priority: "LOW" });
  const invite = (await listNotices(sana.id)).find((n) => n.kind === "TASK_INVITE")!;
  assert.equal(invite.pending, true, "a tap opens the accept screen");
  assert.equal(await markNoticeRead(owner.id, invite.id), false, "not the owner's notice");
  assert.equal((await listNotices(sana.id)).find((n) => n.id === invite.id)?.read, false);
  assert.equal(await markNoticeRead(sana.id, invite.id), true);
  assert.equal((await listNotices(sana.id)).find((n) => n.id === invite.id)?.read, true);
});
