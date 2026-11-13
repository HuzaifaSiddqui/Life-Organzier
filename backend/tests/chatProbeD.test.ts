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

test("D4: duplicates of OPEN tasks ask 'Change X, or add a new task?'; repeats of completed tasks and 'another/again' create", { skip: !dbAvailable && "no database" }, async () => {
  const c = await chatWith([["Renew gym membership", null], ["Buy groceries", null], ["Pay gas bill", null, "COMPLETED"]]);
  const count = async () => (await c.rows()).filter((t) => t.status !== "DELETED").length;
  try {
    await withFixes(async () => {
      for (const say of ["remind me to renew the gym membership tomorrow", "renew gym membership by friday", "buy groceries on saturday"]) {
        const m = await c.send(say);
        assert.equal(m.intent, "change_or_new", say);
        assert.match(m.content, /^Change "(?:Renew gym membership|Buy groceries)", or add a new task\?$/);
      }
      assert.equal(await count(), 3, "nothing added while asking");

      const repeat = await c.send("pay the gas bill tomorrow");
      assert.equal(repeat.intent, "task_created", "an exact repeat of a COMPLETED task creates normally");

      for (const say of ["renew the gym membership again next month", "add another buy groceries task for sunday", "also buy groceries tomorrow"]) {
        const m = await c.send(say);
        assert.notEqual(m.intent, "change_or_new", `${say}: says it is another one`);
        if (m.intent === "clarify") await c.send("cancel");
      }

      const ask = await c.send("buy groceries tomorrow");
      const add = (ask.actions ?? []).find((a) => a.label === "Add a new task");
      assert.ok(add);
      const made = await c.send(null, add!.payload);
      assert.equal(made.intent, "task_created", "the 'Add a new task' button creates it");
      const change = await c.send("remind me to renew the gym membership on monday");
      const keep = (change.actions ?? []).find((a) => a.label.startsWith("Change"));
      const changed = await c.send(null, keep!.payload);
      assert.equal(changed.intent, "task_updated", "the 'Change' button updates the existing one");
    });
  } finally {
    await c.done();
  }
});

test("D4: a routine like an active one on the same days asks first; other days or another routine create", { skip: !dbAvailable && "no database" }, async () => {
  const c = await chatWith([]);
  try {
    await prisma.routine.create({ data: { userId: c.user.id, title: "Swimming class", frequency: "WEEKLY", daysOfWeek: [2, 4], dueTime: "2:00 PM" } });
    await withFixes(async () => {
      const same = await c.send("swimming every tuesday and thursday at 5 pm");
      assert.equal(same.intent, "change_or_new");
      assert.match(same.content, /^You already have the routine "Swimming class" \(Tue, Thu\)\. Change it, or add a new routine\?$/);
      assert.equal(await prisma.routine.count({ where: { userId: c.user.id } }), 1);
      const other = await c.send("swimming every saturday at 9 am");
      assert.notEqual(other.intent, "change_or_new", "no shared day");
      const different = await c.send("guitar practice every tuesday at 6 pm");
      assert.notEqual(different.intent, "change_or_new", "a different routine");
    });
  } finally {
    await c.done();
  }
});

test("D4: the duplicate question does not fire when answering an open draft, in the two-task preview, or for document imports", { skip: !dbAvailable && "no database" }, async () => {
  const c = await chatWith([["Renew passport", null], ["Physics assignment 2", null]]);
  try {
    await withFixes(async () => {
      // Answering an open draft question is not a new request: no duplicate check on the answer.
      const ask = await c.send("add a new task: renew passport");
      assert.equal(ask.intent, "clarify");
      const answered = await c.send("to friday");
      assert.equal(answered.intent, "task_created", "the answer finishes the draft");

      // The two-task preview (PR B) keeps its own flow.
      const two = await c.send("add buy stamps on friday at 4 pm and call the plumber tomorrow");
      assert.equal(two.intent, "create_tasks_confirm");
      await c.send(null, { type: "cancel_pending" });
      const twoDup = await c.send("add renew passport on friday at 4 pm and call the plumber tomorrow");
      assert.equal(twoDup.intent, "create_tasks_one_by_one", "a part matching an open task: one at a time, never the change-or-new question");

      // Document imports: their own rule (exact repeats skipped), never a question.
      const doc = await prisma.document.create({ data: { userId: c.user.id, fileName: "syllabus.pdf", mimeType: "application/pdf", sizeBytes: 10, docType: "SYLLABUS", text: "x" } });
      const { applyDocumentItems } = await import("../src/modules/documents/applyItems.js");
      const r = await applyDocumentItems({ userId: c.user.id, tz: TZ, deviceId: null }, doc.id, { deadlines: [{ title: "Physics assignment 2", date: "2026-11-20", time: "5:00 PM" }], schedules: [] });
      assert.equal(r.tasks.length, 1, "imported as before");
    });
  } finally {
    await c.done();
  }
});

test("D4 on WhatsApp: the question appears; replying 'add a new task' in text creates it; '1' / 'change it' changes the existing one", { skip: !dbAvailable && "no database" }, async () => {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ, tier: "PRO" } });
  await prisma.task.create({ data: { userId: user.id, title: "Call the electrician" } });
  const conversation = await prisma.conversation.create({ data: { userId: user.id, channel: "WHATSAPP", title: "wa" } });
  const send = async (text: string) =>
    (await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, channel: "WHATSAPP", conversationId: conversation.id, now: NOW, text } as never)).message;
  const titles = async () => (await prisma.task.findMany({ where: { userId: user.id, status: { not: "DELETED" } }, select: { title: true, dueDate: true } }));
  try {
    await withFixes(async () => {
      const first = await send("remind me to call the electrician on monday");
      assert.equal(first.intent, "change_or_new");
      const changed = await send("change it");
      assert.equal(changed.intent, "task_updated");
      assert.equal((await titles()).length, 1, "changed, not added");

      const q = await send("remind me to call the electrician tomorrow");
      assert.equal(q.intent, "change_or_new");
      assert.match(q.content, /Change "Call the electrician", or add a new task\?/);
      const made = await send("add a new task");
      assert.equal(made.intent, "task_created");
      assert.equal((await titles()).length, 2);
      const two = await send("remind me to call the electrician on tuesday");
      assert.equal(two.intent, "change_or_new");
      const other = await send("what's due today");
      assert.equal(other.intent, "query_tasks", "another message drops the question and is handled as usual");
    });
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

const STILL_CREATES = [
  "remind me to buy milk tomorrow",
  "add pay rent on friday",
  "I need to submit the lab report by monday",
  "I have to call the plumber tomorrow at 10",
  "what should I cook tonight? remind me to buy chicken at 6 pm",
  "can you remind me to water the plants tomorrow",
  "add a task to book the car service",
  "schedule a dentist visit next tuesday at 4 pm",
  "I should email the professor tomorrow",
  "need to renew my passport next week",
  "set a reminder to take the cake out at 5 pm",
  "don't forget to pay the internet bill on the 20th",
  "I studied the wrong chapter, remind me to revise chapter 4 tomorrow",
  "I must finish the slides by thursday",
  "how should I remember this? add buy a planner to my list",
  "what can I do? remind me to ask the advisor on monday",
  "I spent too long on emails, remind me to block focus time tomorrow at 9",
];
const NO_TASK = [
  "what should I cook for dinner tonight?",
  "how should I prepare for the viva?",
  "which assignment should I start with",
  "what can I do this weekend?",
  "where should I study tomorrow?",
  "how can I focus better tonight?",
  "I studied for 2 hours today",
  "worked on the thesis for 3 hours",
  "spent 90 minutes on chemistry",
  "I practised guitar for an hour",
  "I forgot what I asked you yesterday",
  "same as yesterday",
  "yesterday was exhausting",
];

test("D5: questions and progress reports never create a task; requests (17) still do", { skip: !dbAvailable && "no database" }, async () => {
  const c = await chatWith([]);
  const count = async () => prisma.task.count({ where: { userId: c.user.id } });
  try {
    await withFixes(async () => {
      for (const say of NO_TASK) {
        const before = await count();
        const m = await c.send(say);
        assert.ok(!["task_created", "clarify", "past_date", "change_or_new"].includes(m.intent ?? ""), `${say}: [${m.intent}] ${m.content}`);
        assert.equal(await count(), before, `${say}: no task`);
      }
      assert.equal((await c.send("I studied for 2 hours today")).content, "Nice work — 2 hours of studying.");
      assert.equal((await c.send("spent 90 minutes on chemistry")).content, "Nice work — 1 hour 30 minutes on chemistry.");
      for (const say of STILL_CREATES) {
        const m = await c.send(say);
        assert.ok(["task_created", "clarify", "past_date", "create_tasks_confirm"].includes(m.intent ?? ""), `${say}: [${m.intent}] ${m.content}`);
        if (m.intent !== "task_created") await c.send("cancel");
      }
    });
  } finally {
    await c.done();
  }
});
