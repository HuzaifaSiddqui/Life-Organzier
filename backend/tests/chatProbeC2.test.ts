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

test("s-07 class: a typo completes by itself only above 0.9; 0.8 to 0.9 asks", { skip: !dbAvailable && "no database" }, async () => {
  const c = await chatWith(["Dentist appointment", "Passport renewal", "Water the plants"]);
  try {
    await withFixes(async () => {
      for (const say of ["done with the dentist appointmnt", "finished the pasport renewal"]) {
        const m = await c.send(say);
        assert.equal(m.intent, "choose_task", `${say}: a 0.8 to 0.9 typo asks`);
      }
      assert.deepEqual(await c.statusOf("Dentist appointment"), ["PENDING"]);
      assert.deepEqual(await c.statusOf("Passport renewal"), ["PENDING"]);
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

test("bare 'remind me': asks what; the reply fills the title; a placeholder title is never saved", { skip: !dbAvailable && "no database" }, async () => {
  const c = await chatWith([]);
  const titles = async () => (await prisma.task.findMany({ where: { userId: c.user.id }, select: { title: true } })).map((t) => t.title);
  try {
    await withFixes(async () => {
      const ask = await c.send("remind me");
      assert.equal(ask.content, "What should I remind you about?");
      assert.deepEqual((ask.actions ?? []).map((a) => a.label), ["Cancel"], "no day chips under the 'what' question");
      // A date and time without the 'what': kept, and the question is asked again; nothing saved.
      const timeOnly = await c.send("tonight at 9");
      assert.equal(timeOnly.content, "What should I remind you about?");
      assert.deepEqual(await titles(), []);
      const made = await c.send("water the balcony plants");
      assert.equal(made.intent, "task_created");
      assert.deepEqual(await titles(), ["Water the balcony plants"]);

      const ask2 = await c.send("set a reminder");
      assert.equal(ask2.content, "What should I remind you about?");
      const when = await c.send("to renew the car insurance");
      assert.match(when.content, /When should "Renew the car insurance" be done\?/);
      await c.send("no deadline");
      assert.ok((await titles()).includes("Renew the car insurance"));
      assert.ok(!(await titles()).some((t) => /^remind/i.test(t)), "never a 'Remind me' task");
    });
  } finally {
    await c.done();
  }
});

test("vague 'move something': which task (open, soonest due first), then when; a typed name works", { skip: !dbAvailable && "no database" }, async () => {
  const c = await chatWith(["Quarterly review slides", "Renew car insurance", "!Old essay"]);
  const due = async (title: string) => (await prisma.task.findFirstOrThrow({ where: { userId: c.user.id, title } })).dueDate?.toISOString() ?? null;
  try {
    await prisma.task.updateMany({ where: { userId: c.user.id, title: "Renew car insurance" }, data: { dueDate: new Date("2026-11-19T19:00:00Z"), dueAt: new Date("2026-11-20T18:59:00Z") } });
    await withFixes(async () => {
      const which = await c.send("can you move something");
      assert.equal(which.content, "Which task do you want to move?");
      assert.deepEqual((which.actions ?? []).map((a) => a.label), ["Renew car insurance", "Quarterly review slides"], "open only, soonest due first");
      const when = await c.send("the quarterly review");
      assert.equal(when.content, 'When should I move "Quarterly review slides" to?');
      const moved = await c.send("to next monday");
      assert.equal(moved.intent, "task_updated");
      assert.equal(await due("Quarterly review slides"), "2026-11-15T19:00:00.000Z", "Mon 16 Nov, Karachi");

      await c.send("postpone one to tomorrow");
      const direct = await c.send("2");
      assert.equal(direct.intent, "task_updated", "the day said first is used after the pick");
    });
  } finally {
    await c.done();
  }
});

test("'my week' / 'the week' = this week (Mon–Sun); 'this coming week' = next 7 days", async () => {
  const { resolveRange } = await import("../src/modules/assistant/ranges.js");
  const { parseCtx } = await import("../src/modules/assistant/commands/registry.js");
  const ctx = parseCtx({ now: NOW, tz: TZ });
  const r = (t: string) => {
    const x = resolveRange(t, ctx);
    return x && x !== "unknown" ? [x.from, x.to, x.label] : x;
  };
  await withFixes(() => {
    assert.deepEqual(r("what's my week like"), ["2026-11-09", "2026-11-15", "This week"]);
    assert.deepEqual(r("anything on for the week?"), ["2026-11-09", "2026-11-15", "This week"]);
    assert.deepEqual(r("what do I have this coming week"), ["2026-11-12", "2026-11-19", "Next 7 days"]);
    assert.deepEqual(r("plans for the weekend"), ["2026-11-14", "2026-11-15", "This weekend"], "the weekend is unchanged");
  });
  assert.equal(r("what's my week like"), "unknown", "flag off: as before (the range reader is only used with the flag)");
});

test("bulk move: a named source day other than today moves that day's tasks (preview first), never today's", { skip: !dbAvailable && "no database" }, async () => {
  const c = await chatWith([]);
  const { createTask } = await import("../src/modules/tasks/taskService.js");
  const { dueDateFromYmd } = await import("../src/lib/time.js");
  const mk = (title: string, ymd: string) => createTask({ userId: c.user.id, tz: TZ, deviceId: null }, { title, priority: "MEDIUM", source: "MANUAL", dueDate: dueDateFromYmd(ymd, TZ), dueTime: "5:00 PM" } as never);
  const dueOf = async (title: string) => (await prisma.task.findFirstOrThrow({ where: { userId: c.user.id, title } })).dueDate?.toISOString().slice(0, 10);
  try {
    await mk("Gym bag ready", "2026-11-12"); // today (Thu)
    await mk("Send invoice", "2026-11-14"); // Saturday
    await withFixes(async () => {
      const preview = await c.send("shift everything from saturday to next monday");
      assert.equal(preview.intent, "bulk_move_today_confirm");
      assert.match(preview.content, /^Move 1 task from Saturday to Monday\?/);
      assert.equal(await dueOf("Send invoice"), "2026-11-13", "nothing moves before the confirmation (stored as local midnight, UTC)");
      const moved = await c.send("yes");
      assert.equal(moved.intent, "bulk_moved");
      assert.equal(await dueOf("Send invoice"), "2026-11-15", "Mon 16 Nov");
      assert.equal(await dueOf("Gym bag ready"), "2026-11-11", "today's task is not touched");

      const none = await c.send("move everything from sunday to tuesday");
      assert.equal(none.intent, "bulk_nothing");
      assert.match(none.content, /^Nothing is due or planned Sunday/);

      const todayOnly = await c.send("move everything from today to friday");
      assert.match(todayOnly.content, /^Move 1 task from today to tomorrow\?|^Move 1 task from today to Friday\?/);
    });
  } finally {
    await c.done();
  }
});

test("11:59 PM rule: end of day only with deadline wording; 'remind me' / 'before <event>' ask the time; 'before 12' = 12 PM", { skip: !dbAvailable && "no database" }, async () => {
  const c = await chatWith([]);
  const task = (title: string) => prisma.task.findFirst({ where: { userId: c.user.id, title } });
  try {
    await withFixes(async () => {
      const asked = await c.send("remind me to back up the server before the meeting tomorrow");
      assert.equal(asked.intent, "clarify");
      assert.match(asked.content, /What time is "Back up the server before the meeting" due\?/);
      assert.ok((asked.actions ?? []).some((a) => a.label === "End of day"), "the time chips, as before the flag");
      await c.send("cancel");

      const noon = await c.send("remind me to pay the plumber before 12 tomorrow");
      assert.equal(noon.intent, "task_created");
      assert.equal((await task("Pay the plumber"))?.dueTime, "12 PM", "'before 12' = 12 PM, out of the title");

      const deadline = await c.send("submit the tax form by friday");
      assert.equal(deadline.intent, "task_created");
      assert.match(deadline.content, /Due by the end of the day\. I'll remind you earlier that day\./);
      assert.equal((await task("Submit the tax form"))?.dueTime, null);

      const remindDeadline = await c.send("remind me to submit the visa form by friday");
      assert.equal(remindDeadline.intent, "clarify", "a 'remind me' cue asks the time");
    });
  } finally {
    await c.done();
  }
});

test("end of day also for until / till / before <day>; 'before <event>' asks; 'before <clock>' sets the time; 'remind me … by <day>' asks", { skip: !dbAvailable && "no database" }, async () => {
  const c = await chatWith([]);
  const task = (title: string) => prisma.task.findFirst({ where: { userId: c.user.id, title } });
  const END = /Due by the end of the day\. I'll remind you earlier that day\./;
  try {
    await withFixes(async () => {
      const until = await c.send("the bike service can wait until saturday");
      assert.equal(until.intent, "task_created");
      assert.match(until.content, END);
      const beforeDay = await c.send("renew the parking permit before friday");
      assert.equal(beforeDay.intent, "task_created");
      assert.match(beforeDay.content, END);
      assert.equal((await task("Renew the parking permit"))?.dueTime, null);
      const beforeTomorrow = await c.send("pay the hostel deposit before tomorrow");
      assert.match(beforeTomorrow.content, END);
      const beforeEvent = await c.send("back up the laptop before standup tomorrow");
      assert.equal(beforeEvent.intent, "clarify");
      assert.match(beforeEvent.content, /What time is "Back up the laptop before standup" due\?/);
      await c.send("cancel");
      const beforeClock = await c.send("print the handouts before 5 pm tomorrow");
      assert.equal(beforeClock.intent, "task_created");
      assert.equal((await task("Print the handouts"))?.dueTime, "5 PM");
      const remindBy = await c.send("remind me to renew the parking permit by friday");
      assert.equal(remindBy.intent, "clarify", "'remind me … by <day>' still asks the time");
    });
  } finally {
    await c.done();
  }
});

test("'move some tasks to friday' asks which task (known, tested behaviour)", { skip: !dbAvailable && "no database" }, async () => {
  const c = await chatWith(["Clean the garage", "Order printer ink"]);
  try {
    await withFixes(async () => {
      const m = await c.send("move some tasks to friday");
      assert.equal(m.intent, "choose_task");
      assert.equal(m.content, "Which task do you want to move?");
      const moved = await c.send("Order printer ink");
      assert.equal(moved.intent, "task_updated", "the day said first is applied after the pick");
    });
  } finally {
    await c.done();
  }
});
