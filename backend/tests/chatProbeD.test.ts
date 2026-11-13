import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AiService, setAi } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import { dueDateFromYmd } from "../src/lib/time.js";
import "../src/modules/assistant/commands/registry.js";
import { handleAssistantMessage } from "../src/modules/assistant/dialogue.js";
import { createTask } from "../src/modules/tasks/taskService.js";
import { dbAvailable, TZ } from "./fixtures.js";

/** PR D of the persona baseline fixes (CHAT_FIXES_V2). New sentences, not the persona messages. Thu 12 Nov 2026. */
const NOW = new Date("2026-11-12T12:00:00Z");
const withFixes = async (fn: () => unknown | Promise<unknown>) => {
  const keep = process.env.CHAT_FIXES_V2;
  process.env.CHAT_FIXES_V2 = "on";
  try {
    await fn();
  } finally {
    if (keep === undefined) delete process.env.CHAT_FIXES_V2;
    else process.env.CHAT_FIXES_V2 = keep;
  }
};

/** A throwaway user; tasks as [title, "YYYY-MM-DD" | null, status?]. */
async function chatWith(tasks: Array<[string, string | null, string?]>) {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ, tier: "PRO" } });
  for (const [title, ymd, status] of tasks) {
    const t = await createTask({ userId: user.id, tz: TZ, deviceId: null }, { title, priority: "LOW", source: "MANUAL", ...(ymd ? { dueDate: dueDateFromYmd(ymd, TZ), dueTime: "5:00 PM" } : {}) } as never);
    if (status === "COMPLETED") await prisma.task.update({ where: { id: t.id }, data: { status: "COMPLETED", progress: 100, completedAt: NOW } });
  }
  const conversation = await prisma.conversation.create({ data: { userId: user.id, channel: "APP", title: "t" } });
  const send = async (text: string | null, payload: unknown = null) =>
    (await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, channel: "APP", conversationId: conversation.id, now: NOW, text, payload, label: null } as never)).message;
  const rows = () => prisma.task.findMany({ where: { userId: user.id }, orderBy: { title: "asc" }, select: { title: true, status: true, dueDate: true } });
  return { user, send, rows, done: () => prisma.user.delete({ where: { id: user.id } }) };
}

test("D1: complete / delete a named day's tasks: preview of exactly those, one confirmation, Undo; never a new task", { skip: !dbAvailable && "no database" }, async () => {
  const c = await chatWith([["Water the herbs", "2026-11-12"], ["Post the parcel", "2026-11-14"], ["Iron the shirts", "2026-11-14"], ["File the receipts", "2026-11-18"]]);
  try {
    await withFixes(async () => {
      const done = await c.send("complete all tasks from saturday");
      assert.equal(done.intent, "bulk_day_confirm");
      assert.match(done.content, /^Mark 2 tasks from Saturday as done\?/);
      assert.equal((await c.rows()).length, 4, "no new task");
      await c.send(null, { type: "cancel_pending" });
      assert.ok((await c.rows()).every((t) => t.status === "PENDING"), "cancel changes nothing");

      const mark = await c.send("mark everything for saturday as done");
      assert.equal(mark.intent, "bulk_day_confirm");
      await c.send("yes");
      const after = await c.rows();
      assert.deepEqual(after.filter((t) => t.status === "COMPLETED").map((t) => t.title), ["Iron the shirts", "Post the parcel"]);
      assert.equal(after.find((t) => t.title === "Water the herbs")?.status, "PENDING", "today's task is not touched");
      await c.send("undo");
      assert.ok((await c.rows()).every((t) => t.status === "PENDING"), "one Undo restores both");

      const del = await c.send("delete all of wednesday's tasks");
      assert.equal(del.intent, "bulk_day_confirm");
      assert.match(del.content, /^Delete 1 task from Wednesday\? You can undo this for 24 hours\./);
      await c.send("yes");
      assert.equal((await c.rows()).find((t) => t.title === "File the receipts")?.status, "DELETED");

      const none = await c.send("complete all tasks from sunday");
      assert.equal(none.intent, "bulk_nothing");
      assert.equal(none.content, "Nothing is due or planned Sunday.");
    });
  } finally {
    await c.done();
  }
});

test("D2/D3: postpone non-urgent respects a named day; a day word is never a tag; the old commands are unchanged", { skip: !dbAvailable && "no database" }, async () => {
  const c = await chatWith([["Water the herbs", "2026-11-12"], ["Post the parcel", "2026-11-13"], ["Iron the shirts", "2026-11-14"]]);
  try {
    await withFixes(async () => {
      const fri = await c.send("postpone all non-urgent tasks from friday");
      assert.equal(fri.intent, "bulk_postpone_nonurgent_confirm");
      assert.match(fri.content, /^Move 1 non-urgent task one day later\?/);
      assert.match(fri.content, /Post the parcel/);
      assert.doesNotMatch(fri.content, /Water the herbs/);
      await c.send(null, { type: "cancel_pending" });

      const plain = await c.send("postpone all non-urgent tasks");
      assert.match(plain.content, /^Move 2 non-urgent tasks one day later\?/, "no day named: today and tomorrow, as before");
      await c.send(null, { type: "cancel_pending" });

      const asTag = await c.send("delete all of saturday's tasks");
      assert.equal(asTag.intent, "bulk_day_confirm", "a day, not a tag called 'saturday'");
      await c.send(null, { type: "cancel_pending" });
    });
  } finally {
    await c.done();
  }
});
