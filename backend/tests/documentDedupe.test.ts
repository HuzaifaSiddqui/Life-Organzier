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
