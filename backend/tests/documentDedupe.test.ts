import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AiService, setAi } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import { documentHash, processDocument } from "../src/modules/documents/documentProcessing.js";
import { dbAvailable } from "./fixtures.js";

const skip = !dbAvailable && "no database";

async function withUser(fn: (user: Awaited<ReturnType<typeof prisma.user.create>>, settings: Awaited<ReturnType<typeof prisma.userSettings.create>>) => Promise<void>) {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  const settings = await prisma.userSettings.create({ data: { userId: user.id, timezone: "Asia/Karachi" } });
  try {
    await fn(user, settings);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
}

const upload = (text: string) => ({ text, fileName: "outline.txt", mimeType: "text/plain", docType: "SYLLABUS" as const, language: "eng", autoCreate: true });

test("document hash: same content, type and language match; any difference doesn't", () => {
  const a = { text: "Assignment 1 due 30 November 2026 at 5 PM", docType: "SYLLABUS" as const, language: "eng" };
  assert.equal(documentHash(a), documentHash({ ...a }));
  assert.notEqual(documentHash(a), documentHash({ ...a, docType: "OTHER" }));
  assert.notEqual(documentHash(a), documentHash({ ...a, language: "urd" }));
  assert.notEqual(documentHash(a), documentHash({ ...a, text: `${a.text}.` }));
});

test("retrying the same upload after a timeout returns the saved document: no second document, no duplicate tasks", { skip }, async () => {
  await withUser(async (user, settings) => {
    const first = await processDocument(user, settings, upload("Assignment 1 due 30 November 2026 at 5 PM"));
    assert.equal(first.reused, false);
    assert.equal(first.createdTasks.length, 1);
    const retry = await processDocument(user, settings, upload("Assignment 1 due 30 November 2026 at 5 PM"));
    assert.equal(retry.reused, true);
    assert.equal(retry.document.id, first.document.id);
    assert.equal(retry.extracted.deadlines[0].created, true, "the saved extraction says it was already added");
    assert.equal(await prisma.document.count({ where: { userId: user.id } }), 1);
    assert.equal(await prisma.task.count({ where: { userId: user.id } }), 1);
  });
});

test("two identical uploads at the same time (phone re-sent it) share one run: one document, one task", { skip }, async () => {
  await withUser(async (user, settings) => {
    const [a, b] = await Promise.all([processDocument(user, settings, upload("Quiz 2 on 12 November 2026 at 9 AM")), processDocument(user, settings, upload("Quiz 2 on 12 November 2026 at 9 AM"))]);
    assert.equal(a.document.id, b.document.id);
    assert.equal(await prisma.document.count({ where: { userId: user.id } }), 1);
    assert.equal(await prisma.task.count({ where: { userId: user.id } }), 1);
  });
});

test("two users uploading identical bytes each get their own document and tasks; neither sees the other's", { skip }, async () => {
  await withUser(async (alice, aliceSettings) => {
    await withUser(async (bob, bobSettings) => {
      const text = "Final project due 10 December 2026 at 5 PM";
      const [a, b] = await Promise.all([processDocument(alice, aliceSettings, upload(text)), processDocument(bob, bobSettings, upload(text))]);
      assert.notEqual(a.document.id, b.document.id);
      assert.equal(a.reused, false);
      assert.equal(b.reused, false, "another user's upload is never reused");
      assert.equal(await prisma.document.count({ where: { userId: alice.id } }), 1);
      assert.equal(await prisma.document.count({ where: { userId: bob.id } }), 1);
      const aliceTasks = await prisma.task.findMany({ where: { userId: alice.id } });
      const bobTasks = await prisma.task.findMany({ where: { userId: bob.id } });
      assert.equal(aliceTasks.length, 1);
      assert.equal(bobTasks.length, 1);
      assert.equal(a.extracted.deadlines[0].taskId, aliceTasks[0].id);
      assert.equal(b.extracted.deadlines[0].taskId, bobTasks[0].id);
      // Bob uploads it again: he gets his own document back, not Alice's.
      const again = await processDocument(bob, bobSettings, upload(text));
      assert.equal(again.document.id, b.document.id);
    });
  });
});

test("reused result after deleting the auto-created task: not claimed as created, offered again, not re-created", { skip }, async () => {
  await withUser(async (user, settings) => {
    const text = "Assignment 3 due 25 November 2026 at 5 PM";
    const first = await processDocument(user, settings, upload(text));
    const taskId = first.extracted.deadlines[0].taskId as string;
    assert.ok(taskId);
    await prisma.task.update({ where: { id: taskId }, data: { status: "DELETED", deletedAt: new Date() } });
    const again = await processDocument(user, settings, upload(text));
    assert.equal(again.reused, true);
    const d = again.extracted.deadlines[0];
    assert.equal(d.created, false);
    assert.equal(d.existing, false);
    assert.equal(d.taskId, undefined);
    assert.equal(d.removedSinceUpload, true);
    assert.equal(await prisma.task.count({ where: { userId: user.id, status: { not: "DELETED" } } }), 0, "not re-created automatically");
    // The saved document itself is unchanged (a later reuse recomputes again).
    const stored = (await prisma.document.findUniqueOrThrow({ where: { id: first.document.id } })).extracted as { deadlines: Array<{ taskId?: string }> };
    assert.equal(stored.deadlines[0].taskId, taskId);
  });
});
