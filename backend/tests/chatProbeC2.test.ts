import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AiService, setAi } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import "../src/modules/assistant/commands/registry.js";
import { handleAssistantMessage } from "../src/modules/assistant/dialogue.js";
import { coversAll } from "../src/modules/assistant/draft.js";
import { dbAvailable, TZ } from "./fixtures.js";

/** C2 of the persona baseline fixes (CHAT_FIXES_V2). New sentences, not the persona messages. Thu 12 Nov 2026. */
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

/** A throwaway user with the given tasks ("!" = completed today), and a chat to send messages to. */
async function chatWith(titles: string[]) {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ, tier: "PRO" } });
  for (const raw of titles) {
    const done = raw.startsWith("!");
    await prisma.task.create({ data: { userId: user.id, title: raw.replace(/^!/, ""), ...(done ? { status: "COMPLETED", progress: 100, completedAt: new Date("2026-11-12T06:00:00Z") } : {}) } });
  }
  const conversation = await prisma.conversation.create({ data: { userId: user.id, channel: "APP", title: "t" } });
  const send = async (text: string) =>
    (await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, channel: "APP", conversationId: conversation.id, now: NOW, text } as never)).message;
  const statusOf = async (title: string) => (await prisma.task.findMany({ where: { userId: user.id, title }, select: { status: true } })).map((t) => t.status);
  return { user, send, statusOf, done: () => prisma.user.delete({ where: { id: user.id } }) };
}

test("s-07 class: full word coverage only", () => {
  assert.equal(coversAll("budget report", "Submit quarterly budget report"), true);
  assert.equal(coversAll("budget review", "Submit quarterly budget report"), false, "half the words");
  assert.equal(coversAll("lab report", "Submit FYP progress report"), false);
});

test("s-07 class: complete / delete pick a task by themselves only on full coverage; already-done is said", { skip: !dbAvailable && "no database" }, async () => {
  const c = await chatWith(["Submit quarterly budget report", "Book flight to Lahore", "!Physics lab report"]);
  try {
    await withFixes(async () => {
      const half = await c.send("I finished the budget review");
      assert.equal(half.intent, "choose_task", "half the words: asks which task");
      assert.deepEqual(await c.statusOf("Submit quarterly budget report"), ["PENDING"], "nothing completed");

      const del = await c.send("delete the budget review");
      assert.equal(del.intent, "choose_task");
      assert.deepEqual(await c.statusOf("Submit quarterly budget report"), ["PENDING"]);

      const done = await c.send("done with the lab report");
      assert.equal(done.intent, "already_done");
      assert.equal(done.content, '"Physics lab report" is already done (today).');
      assert.deepEqual(await c.statusOf("Submit quarterly budget report"), ["PENDING"], "the open report is not touched");

      const full = await c.send("done with the budget report");
      assert.equal(full.intent, "task_completed", "every word is in the title: completes");
      assert.deepEqual(await c.statusOf("Submit quarterly budget report"), ["COMPLETED"]);
    });
  } finally {
    await c.done();
  }
});

test("s-07 class: an open task with the same title as a completed one wins", { skip: !dbAvailable && "no database" }, async () => {
  const c = await chatWith(["!Weekly report", "Weekly report"]);
  try {
    await withFixes(async () => {
      const m = await c.send("finished the weekly report");
      assert.equal(m.intent, "task_completed");
      assert.deepEqual((await c.statusOf("Weekly report")).sort(), ["COMPLETED", "COMPLETED"]);
    });
  } finally {
    await c.done();
  }
});

test("s-07 class: flag off is unchanged (half the words still asks, as before)", { skip: !dbAvailable && "no database" }, async () => {
  const c = await chatWith(["Submit quarterly budget report", "!Physics lab report"]);
  try {
    const m = await c.send("done with the lab report");
    assert.notEqual(m.intent, "already_done");
    assert.deepEqual(await c.statusOf("Physics lab report"), ["COMPLETED"]);
  } finally {
    await c.done();
  }
});
