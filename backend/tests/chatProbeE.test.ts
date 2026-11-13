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

/** PR E of the persona baseline fixes (CHAT_FIXES_V2). New sentences, not the persona messages. Thu 12 Nov 2026. */
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
    const t = await createTask({ userId: user.id, tz: TZ, deviceId: null }, { title, priority: "MEDIUM", source: "MANUAL", ...(ymd ? { dueDate: dueDateFromYmd(ymd, TZ), dueTime: "5:00 PM" } : {}) } as never);
    if (status === "COMPLETED") await prisma.task.update({ where: { id: t.id }, data: { status: "COMPLETED", progress: 100, completedAt: NOW } });
  }
  const conversation = await prisma.conversation.create({ data: { userId: user.id, channel: "APP", title: "t" } });
  const send = async (text: string | null, payload: unknown = null) =>
    (await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, channel: "APP", conversationId: conversation.id, now: NOW, text, payload, label: null } as never)).message;
  const routines = () => prisma.routine.count({ where: { userId: user.id } });
  return { user, send, routines, done: () => prisma.user.delete({ where: { id: user.id } }) };
}

test("E7: a repeat with a limit is shown first ('Repeats every day until you stop it.', Save / Cancel); direct requests save at once", { skip: !dbAvailable && "no database" }, async () => {
  const c = await chatWith([]);
  try {
    await withFixes(async () => {
      const preview = await c.send("revise for the finals every evening this week");
      assert.equal(preview.intent, "routine_preview");
      assert.match(preview.content, /Repeats every day until you stop it\.$/);
      assert.deepEqual((preview.actions ?? []).map((a) => a.label), ["Save", "Cancel"]);
      assert.equal(await c.routines(), 0, "nothing saved before Save");
      const saved = await c.send(null, (preview.actions ?? [])[0].payload);
      assert.equal(saved.intent, "routine_created");
      assert.equal(await c.routines(), 1);

      const again = await c.send("go for a walk every morning until friday");
      assert.equal(again.intent, "routine_preview");
      const cancelled = await c.send(null, (again.actions ?? [])[1].payload);
      assert.match(cancelled.content, /cancel/i);
      assert.equal(await c.routines(), 1, "Cancel adds nothing");

      for (const say of ["daily meditation at 6 AM", "walk the dog every evening at 6", "gym every monday and thursday at 7 pm"]) {
        const m = await c.send(say);
        assert.equal(m.intent, "routine_created", `${say}: saves at once, as today`);
      }
    });
  } finally {
    await c.done();
  }
});

test("E8: a split with no names asks how; named or counted parts are shown first; never one junk subtask", { skip: !dbAvailable && "no database" }, async () => {
  const c = await chatWith([["Write the marketing plan", null]]);
  const subtasks = () => prisma.task.findMany({ where: { userId: c.user.id, parentTaskId: { not: null } }, orderBy: { createdAt: "asc" }, select: { title: true } });
  try {
    await withFixes(async () => {
      const ask = await c.send("split the marketing plan into smaller tasks");
      assert.equal(ask.content, "How should I split it? For example: outline, draft, review.");
      assert.deepEqual(await subtasks(), [], "no junk subtask");
      const preview = await c.send("research, outline and draft");
      assert.equal(preview.intent, "split_preview");
      assert.deepEqual((preview.actions ?? []).map((a) => a.label), ["Add them", "Cancel"]);
      assert.deepEqual(await subtasks(), [], "nothing before 'Add them'");
      await c.send(null, (preview.actions ?? [])[0].payload);
      assert.deepEqual((await subtasks()).map((t) => t.title), ["Research", "Outline", "Draft"]);

      const named = await c.send("break the marketing plan into budget and timeline");
      assert.equal(named.intent, "split_preview");
      await c.send(null, (named.actions ?? [])[1].payload);
      assert.equal((await subtasks()).length, 3, "Cancel adds nothing");
    });
  } finally {
    await c.done();
  }
});
