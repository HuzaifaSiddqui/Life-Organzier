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

test("E10: a plan with nothing due names the most urgent open tasks, never '0 min of work'; a day with work is planned as before", { skip: !dbAvailable && "no database" }, async () => {
  const empty = await chatWith([]);
  try {
    await withFixes(async () => {
      assert.equal((await empty.send("plan my day")).content, "Nothing is due today, and you have no open tasks.");
    });
  } finally {
    await empty.done();
  }
  const open = await chatWith([["Finish the thesis chapter", "2026-11-16"], ["Buy a gift for Ayesha", null]]);
  try {
    await withFixes(async () => {
      const m = await open.send("plan my evening");
      assert.match(m.content, /^Nothing is due today\. Most urgent:\n1\) Finish the thesis chapter/);
      assert.doesNotMatch(m.content, /0 min of work/);
    });
  } finally {
    await open.done();
  }
  const busy = await chatWith([["Submit the lab report", "2026-11-12"]]);
  try {
    await withFixes(async () => {
      const m = await busy.send("plan my day");
      assert.match(m.content, /^Here's today's plan/, "a day with work: the plan as before");
    });
  } finally {
    await busy.done();
  }
});

test("E11: 'when is …' / 'which days does … happen' from tasks and routines; several: up to 3 and ask; no match: as today", { skip: !dbAvailable && "no database" }, async () => {
  const c = await chatWith([["Parent-teacher meeting at school", "2026-11-16"], ["Physics quiz", "2026-11-17"], ["Physics lab report", "2026-11-18"], ["Physics assignment 2", "2026-11-19"], ["Physics revision", null]]);
  try {
    await prisma.routine.create({ data: { userId: c.user.id, title: "Tuition pickup", frequency: "WEEKLY", daysOfWeek: [1, 3], dueTime: "3:30 PM" } });
    const tasksBefore = await prisma.task.count({ where: { userId: c.user.id } });
    await withFixes(async () => {
      const meeting = await c.send("when is the school meeting?");
      assert.equal(meeting.intent, "lookup");
      assert.match(meeting.content, /^"Parent-teacher meeting at school" is due /);
      const pickup = await c.send("which days does the tuition pickup happen?");
      assert.equal(pickup.content, '"Tuition pickup": Mon, Wed at 3:30 PM.');
      const several = await c.send("when is physics?");
      assert.equal(several.intent, "lookup_choose");
      assert.equal((several.actions ?? []).length, 3, "at most 3");
      assert.match(several.content, /^Which one do you mean\?/);
      const eid = await c.send("when is Eid?");
      assert.ok(!["lookup", "lookup_choose"].includes(eid.intent ?? ""), "no matching task: as today");
      assert.equal(await prisma.task.count({ where: { userId: c.user.id } }), tasksBefore, "read-only");
    });
  } finally {
    await c.done();
  }
});

test("E9: a topic word filters the urgent and pending lists; 'tomorrow' also names tomorrow's routines", { skip: !dbAvailable && "no database" }, async () => {
  const c = await chatWith([["Library fine", "2026-11-13"], ["Statistics assignment 2", "2026-11-14"], ["Databases assignment", "2026-11-17"], ["Workshop slides", "2026-11-18"], ["Book hotel for the workshop", null]]);
  try {
    const { createRoutine } = await import("../src/modules/routines/routineService.js");
    const swim = await createRoutine(c.user.id, TZ, { title: "Swimming", frequency: "WEEKLY", daysOfWeek: [5], dueTime: "7:00 AM" } as never, NOW); // Fridays
    // The test clock (12 Nov) is before the real creation time; occurrences are only made from the creation day on.
    await prisma.routine.update({ where: { id: swim.id }, data: { createdAt: new Date("2026-11-01T00:00:00Z") } });
    await withFixes(async () => {
      const urgent = await c.send("which of my assignments is most urgent?");
      assert.match(urgent.content, /^Most urgent \(assignment\):\n1\) Statistics assignment 2/);
      assert.doesNotMatch(urgent.content, /Library fine/, "the library fine is not an assignment");

      const none = await c.send("which of my essays is most urgent?");
      assert.match(none.content, /^No open tasks about "essay"\. Most urgent overall:/);

      const pending = await c.send("what's pending for the workshop?");
      const titles = (pending.cards ?? []).flatMap((x) => ((x as { tasks?: Array<{ title: string }> }).tasks ?? []).map((t) => t.title));
      assert.deepEqual(titles.sort(), ["Book hotel for the workshop", "Workshop slides"]);

      const tomorrow = await c.send("what's on tomorrow");
      assert.match(tomorrow.content, /Routines tomorrow: Swimming \(7:00 AM\)\./);
    });
  } finally {
    await c.done();
  }
});
