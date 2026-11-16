import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { prisma } from "../src/config/db.js";
import { useTestAuth } from "../src/config/firebase.js";
import { documentCard, documentChatSummary } from "../src/modules/documents/chatUpload.js";
import { dbAvailable, TZ } from "./fixtures.js";

/** Documents sent in the assistant chat: the card, the fixed summary, and the exchange written into the chat. */

const result = (over: Partial<Parameters<typeof documentCard>[0]> = {}) => ({
  document: { id: "d1", fileName: "timetable.pdf" },
  extracted: {
    deadlines: [{ created: true }, {}, { filteredOut: true }],
    schedules: [{}, {}, { existing: true }],
    warning: null,
  },
  createdTasks: [{}],
  createdRoutines: [],
  ...over,
});

test("chat upload card: counts shown items, what was added and what waits for review", () => {
  const card = documentCard(result());
  assert.deepEqual({ d: card.deadlines, s: card.schedules, added: card.added, review: card.toReview }, { d: 2, s: 3, added: 1, review: 3 });
});

test("chat upload summary: fixed wording in English and Urdu", () => {
  const card = documentCard(result());
  assert.equal(documentChatSummary(card, "en"), "I read timetable.pdf and found 2 deadlines and 3 classes. I added the one I was sure about. 3 items are waiting for your review.");
  assert.match(documentChatSummary(card, "ur"), /timetable\.pdf/);
  const empty = documentCard(result({ extracted: { deadlines: [], schedules: [], warning: null }, createdTasks: [] }));
  assert.equal(documentChatSummary(empty, "en"), "I read timetable.pdf but didn't find any dates or class times in it.");
  assert.match(documentChatSummary(documentCard(result({ reused: true })), "en"), /before/);
});

test("chat upload route: the file and request, and the summary with its card, land in the chat; the review reopens it", { skip: !dbAvailable && "no database" }, async () => {
  const keepEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  useTestAuth({ verifyIdToken: async (token: string) => ({ uid: token, email: `${token}@example.test` }) as never });
  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const uid = `chatdoc-${randomUUID()}`;
  const user = await prisma.user.create({ data: { firebaseUid: uid, email: `${uid}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ } });
  try {
    const form = new FormData();
    form.append("file", new Blob(["Assignment 2 due on 20 December 2026 at 5 PM.\nQuiz 3 on 22 December 2026."], { type: "text/plain" }), "notice.txt");
    form.append("docType", "AUTO");
    form.append("chat", "true");
    form.append("instruction", "only the assignment please");
    const res = await fetch(`${base}/documents`, { method: "POST", headers: { authorization: `Bearer ${uid}` }, body: form });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { data: { document: { id: string; docType: string }; chat: { conversationId: string; messages: Array<{ role: string; content: string; metadata: { cards?: Array<{ type: string; documentId: string }> } }> } } };
    assert.equal(body.data.document.docType, "OTHER", "AUTO was resolved and stored as a real type");
    const [mine, reply] = body.data.chat.messages;
    assert.equal(mine.role, "USER");
    assert.equal(mine.content, "only the assignment please");
    assert.equal(reply.role, "ASSISTANT");
    assert.equal(reply.metadata.cards?.[0]?.type, "document");
    assert.equal(reply.metadata.cards?.[0]?.documentId, body.data.document.id);
    assert.equal(await prisma.conversationMessage.count({ where: { conversationId: body.data.chat.conversationId } }), 2);

    const again = await fetch(`${base}/documents/${body.data.document.id}`, { headers: { authorization: `Bearer ${uid}` } });
    const reopened = (await again.json()) as { data: { result: { document: { id: string }; extracted: { deadlines: unknown[] } } } };
    assert.equal(reopened.data.result.document.id, body.data.document.id);
    assert.ok(reopened.data.result.extracted.deadlines.length >= 1);
  } finally {
    await prisma.user.deleteMany({ where: { id: user.id } });
    server.close();
    process.env.NODE_ENV = keepEnv;
  }
});
