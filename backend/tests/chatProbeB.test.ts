import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AiService, setAi } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import "../src/modules/assistant/commands/registry.js";
import { appQuestionReply } from "../src/modules/assistant/appQuestions.js";
import { parseTwoTasks } from "../src/modules/assistant/commands/compound.js";
import { getCommand, parseCtx } from "../src/modules/assistant/commands/registry.js";
import { handleAssistantMessage } from "../src/modules/assistant/dialogue.js";
import { extractEntities } from "../src/modules/assistant/entities.js";
import { feelingTail, rulesUnderstand } from "../src/modules/assistant/nlu.js";
import { resolveRange } from "../src/modules/assistant/ranges.js";
import { readInstruction } from "../src/modules/documents/instructions.js";
import { dbAvailable, TZ } from "./fixtures.js";

/** PR B of the 29-message chat probe (CHAT_FIXES_V2). Thursday 12 Nov 2026, Asia/Karachi. */
const NOW = new Date("2026-11-12T07:00:00Z");
const opts = { now: NOW, tz: TZ, contexts: [] as string[] };
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

test("week: 'this week' is Monday to Sunday; 'next week' the next Monday to Sunday", async () => {
  await withFixes(() => {
    const at = (iso: string) => parseCtx({ now: new Date(iso), tz: TZ });
    const r = (text: string, iso = "2026-11-12T07:00:00Z") => {
      const x = resolveRange(text, at(iso));
      return x && x !== "unknown" ? [x.from, x.to] : x;
    };
    assert.deepEqual(r("what's due this week"), ["2026-11-09", "2026-11-15"], "Thursday");
    assert.deepEqual(r("what's due this week", "2026-11-09T07:00:00Z"), ["2026-11-09", "2026-11-15"], "Monday");
    assert.deepEqual(r("what's due this week", "2026-11-15T07:00:00Z"), ["2026-11-09", "2026-11-15"], "Sunday");
    assert.deepEqual(r("what's due next week"), ["2026-11-16", "2026-11-22"]);
    assert.deepEqual(r("anything in the next 7 days"), ["2026-11-12", "2026-11-19"], "said as a rolling span: kept");
  });
});

test("week: a document instruction 'only this week' follows the same week (Monday to Sunday with CHAT_FIXES_V2)", async () => {
  await withFixes(() => {
    const r = readInstruction("only this week", [], [], "2026-11-12");
    assert.deepEqual(r.filter.dateRange, { from: "2026-11-09", to: "2026-11-15" });
  });
  const keep = process.env.CHAT_FIXES_V2;
  delete process.env.CHAT_FIXES_V2;
  try {
    assert.deepEqual(readInstruction("only this week", [], [], "2026-11-12").filter.dateRange, { from: "2026-11-12", to: "2026-11-18" }, "flag off: as before");
  } finally {
    if (keep !== undefined) process.env.CHAT_FIXES_V2 = keep;
  }
});

test("completed: 'just' = the latest; 'this week' = since Monday; 'last 7 days' stays rolling; names are listed", async () => {
  await withFixes(() => {
    const c = getCommand("insights_completed")!;
    const p = (t: string) => c.parse(t, parseCtx(opts));
    assert.equal(p("What did I just complete?")?.latest, true);
    assert.deepEqual(p("show me everything I finished this week"), { range: "week", calendar: true, list: true });
    assert.deepEqual(p("how many tasks did I complete this week?"), { range: "week", calendar: true });
    assert.deepEqual(p("how many tasks did I complete in the last 7 days?"), { range: "week" });
    assert.equal(p("show my completed tasks")?.list, true);
    assert.equal(p("delete all completed tasks"), null);
  });
});

test("open tasks: 'not done', 'unfinished', 'remaining' list open tasks, never the completed ones", async () => {
  await withFixes(() => {
    for (const t of ["show me tasks that are not done", "what's unfinished", "show my incomplete tasks", "what tasks are pending", "tasks I haven't done yet", "show me undone tasks", "remaining tasks", "what haven't I finished yet?"]) {
      assert.equal(rulesUnderstand(t, opts).intent, "query_tasks", t);
      assert.equal(getCommand("insights_completed")!.parse(t, parseCtx(opts)), null, `${t}: not the completed list`);
    }
    assert.notEqual(rulesUnderstand("remind me to pay the remaining fees tomorrow", opts).intent, "query_tasks", "a task with 'remaining' is still a task");
  });
});

test("B5: priority words need 'priority' or a clear marker; a trailing feeling is a mood", async () => {
  await withFixes(() => {
    const pr = (t: string) => extractEntities(t, opts).priority;
    assert.equal(pr("call mom, feeling low today"), null);
    assert.equal(pr("high school reunion on friday"), null);
    assert.equal(pr("low on cash, pay rent friday"), null);
    assert.equal(pr("pay bills, low priority"), "LOW");
    assert.equal(pr("make it high"), "HIGH");
    assert.equal(pr("set it to low"), "LOW");
    assert.equal(pr("submit the essay, important"), "HIGH");
    assert.equal(pr("whenever you can, clean the garage"), "LOW");
    assert.equal(feelingTail("call mom, feeling low today"), "call mom today", "the day stays with the task");
    assert.equal(feelingTail("finish the slides - I'm feeling tired"), "finish the slides");
    assert.equal(feelingTail("feeling low today"), null);
    const u = rulesUnderstand("call mom, feeling low today", opts);
    assert.equal(u.intent, "create_task");
    assert.equal(u.title, "Call mom");
    assert.ok(u.mood, "the feeling is kept as the mood");
  });
});

test("B5: two tasks in one message only when each part has its own date or time and the second starts with a verb", async () => {
  await withFixes(() => {
    const two = parseTwoTasks("add dentist on friday at 4 pm and call the bank tomorrow", opts);
    assert.deepEqual(two?.map((p) => [p.title, p.date, p.time]), [["Dentist", "2026-11-13", "4 PM"], ["Call the bank", "2026-11-13", null]]);
    for (const t of ["buy bread and eggs tomorrow", "add lunch with Ali and Sara tomorrow", "remind me to call mom and buy milk tomorrow", "call the bank tomorrow and the dentist friday"]) assert.equal(parseTwoTasks(t, opts), null, t);
  });
});

test("B6: weather is out of scope; the place is named only when the user named one", () => {
  assert.equal(appQuestionReply("what's the weather like in Lahore?")?.content, "I can't check the weather in Lahore, so your weather app is the best place for that.");
  assert.equal(appQuestionReply("will it rain tomorrow?")?.content, "I can't check the weather, so your weather app is the best place for that.");
  assert.equal(appQuestionReply("what's the weather in the morning")?.content, "I can't check the weather, so your weather app is the best place for that.");
  for (const t of ["remind me to check the weather tomorrow", "take an umbrella if it rains", "add weather report to slides", "what temperature for baking?", "what temperature should the oven be"]) assert.equal(appQuestionReply(t), null, t);
  assert.equal(appQuestionReply("what's the weather like in lahore?")?.content, "I can't check the weather, so your weather app is the best place for that.", "a place only when capitalised");
  assert.equal(appQuestionReply("is it raining in Karachi?")?.content, "I can't check the weather in Karachi, so your weather app is the best place for that.");
});

test("#26: 'help me plan tomorrow' plans that day; a task about planning is still a task", async () => {
  await withFixes(() => {
    assert.equal(rulesUnderstand("I have too much to do, can you help me plan tomorrow?", opts).intent, "plan_day");
    assert.equal(rulesUnderstand("plan today", opts).intent, "plan_day");
    assert.notEqual(rulesUnderstand("remind me to plan tomorrow's lecture", opts).intent, "plan_day");
  });
});

test("through the chat: two tasks (one preview, one Undo), never a silent duplicate; filler; no completed in 'which task?'", { skip: !dbAvailable && "no database" }, async () => {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ, tier: "PRO" } });
  const conversation = await prisma.conversation.create({ data: { userId: user.id, channel: "APP", title: "t" } });
  const send = async (text: string | null, payload: unknown = null) =>
    (await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, channel: "APP", conversationId: conversation.id, now: NOW, text, payload, label: null } as never)).message;
  const open = () => prisma.task.findMany({ where: { userId: user.id, status: { in: ["PENDING", "IN_PROGRESS"] } }, orderBy: { title: "asc" } });
  try {
    await withFixes(async () => {
      const preview = await send("add dentist on friday at 4 pm and call the bank tomorrow");
      assert.equal(preview.intent, "create_tasks_confirm");
      assert.equal((await open()).length, 0, "nothing before the preview is accepted");
      const added = await send(null, { type: "confirm_pending" });
      assert.equal(added.intent, "tasks_created");
      assert.deepEqual((await open()).map((t) => t.title), ["Call the bank", "Dentist"]);
      assert.equal((await send("undo")).intent !== undefined, true);
      assert.equal((await open()).length, 0, "one Undo removes both");

      await prisma.task.create({ data: { userId: user.id, title: "Dentist appointment" } });
      const dup = await send("add dentist on friday at 4 pm and call the bank tomorrow");
      assert.equal(dup.intent, "create_tasks_one_by_one");
      assert.equal((await open()).length, 1, "nothing added when a part is already there");

      await prisma.task.create({ data: { userId: user.id, title: "Old essay", status: "COMPLETED", completedAt: NOW } });
      const which = await send("move it to tomorrow");
      if (which.intent === "choose_task") assert.ok(!(which.actions ?? []).some((a) => a.label === "Old essay"), "no completed task offered");

      for (const t of ["show me tasks that are not done", "what's unfinished", "show my incomplete tasks"]) {
        const list = await send(t);
        const shown = (list.cards ?? []).flatMap((c) => ((c as { tasks?: Array<{ title: string }> }).tasks ?? []).map((x) => x.title));
        assert.ok(shown.includes("Dentist appointment") && !shown.includes("Old essay"), `${t}: ${shown.join(", ")}`);
        assert.equal(list.intent, "query_tasks", t);
      }
      const moved = await send("actually move dentist appointment to monday");
      assert.equal(moved.intent, "task_updated");
      assert.match(moved.content, /Dentist appointment/);
    });
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});
