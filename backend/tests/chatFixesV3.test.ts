import assert from "node:assert/strict";
import test from "node:test";
import { parseCtx } from "../src/modules/assistant/commands/registry.js";
import { resolveRange } from "../src/modules/assistant/commands/find.js";
import { extractEntities } from "../src/modules/assistant/entities.js";

// CHAT_FIXES_V2, third round. New sentences only (none from the AI-written sets).
function withFlag<T>(run: () => T): T {
  const keep = process.env.CHAT_FIXES_V2;
  process.env.CHAT_FIXES_V2 = "on";
  try {
    return run();
  } finally {
    if (keep === undefined) delete process.env.CHAT_FIXES_V2;
    else process.env.CHAT_FIXES_V2 = keep;
  }
}
const ctxOn = (ymd: string) => parseCtx({ now: new Date(`${ymd}T05:00:00Z`), tz: "Asia/Karachi" } as never);

test("range queries: next week, weekends, after the weekend, months, by / before, weekday names and the 12th", () => {
  withFlag(() => {
    const mon = ctxOn("2026-10-05"); // Monday
    const sat = ctxOn("2026-10-10");
    const sun = ctxOn("2026-10-11");
    const r = (text: string, ctx = mon) => {
      const x = resolveRange(text, ctx);
      return x && x !== "unknown" ? [x.from, x.to] : x;
    };
    assert.deepEqual(r("anything on my plate next week?"), ["2026-10-12", "2026-10-18"]);
    assert.deepEqual(r("what have I got this weekend"), ["2026-10-10", "2026-10-11"]);
    assert.deepEqual(r("what have I got this weekend", sat), ["2026-10-10", "2026-10-11"]);
    assert.deepEqual(r("what have I got this weekend", sun), ["2026-10-11", "2026-10-11"]);
    assert.deepEqual(r("show me next weekend"), ["2026-10-17", "2026-10-18"]);
    assert.deepEqual(r("which deadlines come after the weekend", sat), ["2026-10-12", "2026-10-18"]);
    assert.deepEqual(r("list what's left this month"), ["2026-10-05", "2026-10-31"]);
    assert.deepEqual(r("anything due next month"), ["2026-11-01", "2026-11-30"]);
    assert.deepEqual(r("what must be done by wednesday"), ["2026-10-05", "2026-10-07"]);
    assert.deepEqual(r("what's due before wednesday"), ["2026-10-05", "2026-10-06"]);
    assert.deepEqual(r("what do I have on friday"), ["2026-10-09", "2026-10-09"]);
    assert.deepEqual(r("anything due on the 14th?"), ["2026-10-14", "2026-10-14"]);
    assert.equal(r("what's coming up soon"), "unknown", "a span it can't read is asked about");
    assert.equal(r("show my tasks"), null, "no time asked");
  });
});

test("'on the 12th' and 'X on the 20th' are dates (this month, or next once passed)", () => {
  withFlag(() => {
    const opts = { now: new Date("2026-10-05T05:00:00Z"), tz: "Asia/Karachi" };
    assert.equal(extractEntities("renew the passport on the 12th", opts).date?.ymd, "2026-10-12");
    assert.equal(extractEntities("parents' meeting on the 20th at 6 pm", opts).date?.ymd, "2026-10-20");
    assert.equal(extractEntities("pay the gym fee on 2nd", opts).date?.ymd, "2026-11-02", "passed: next month");
    assert.equal(extractEntities("print the 3 handouts", opts).date, null, "a plain number is not a day");
  });
  assert.equal(extractEntities("renew the passport on the 12th", { now: new Date("2026-10-05T05:00:00Z"), tz: "Asia/Karachi" }).date, null, "flag off: unchanged");
});

const opts = { now: new Date("2026-10-05T05:00:00Z"), timezone: "Asia/Karachi", tz: "Asia/Karachi" } as never;

test("feelings and states never create tasks, even with a time word; an action keeps the task", async () => {
  const { rulesUnderstand } = await import("../src/modules/assistant/nlu.js");
  withFlag(() => {
    for (const t of ["really drained this evening", "pretty stressed today", "super sleepy this afternoon", "a bit nervous today", "honestly burnt out today"]) {
      assert.equal(rulesUnderstand(t, opts).intent, "log_mood", t);
    }
    for (const t of ["call mom, feeling low today", "buy coffee, so tired today", "anxious about the viva at 3 pm"]) assert.equal(rulesUnderstand(t, opts).intent, "create_task", t);
  });
});

test("a delete / remove / clear verb never completes; bulk phrasings reach the bulk commands", async () => {
  const { rulesUnderstand } = await import("../src/modules/assistant/nlu.js");
  const { matchCommand } = await import("../src/modules/assistant/commands/registry.js");
  const { guardModelChoice } = await import("../src/modules/assistant/guards.js");
  withFlag(() => {
    const ctx = parseCtx(opts);
    for (const t of ["get rid of the completed ones", "delete the finished stuff", "clear the completed ones from my list"]) {
      assert.equal(matchCommand(t, ctx)?.command.name, "bulk_delete_completed", t);
      assert.notEqual(rulesUnderstand(t, opts).intent, "complete_task", t);
    }
    assert.deepEqual(matchCommand("delete all my errands", ctx)?.args, { group: "errands" });
    assert.equal(matchCommand("push all my errands to friday", ctx)?.command.name, "bulk_move_group");
    assert.equal(matchCommand("move everything to tomorrow", ctx)?.command.name, "bulk_move_today");
    assert.equal(matchCommand("shift all of today to thursday", ctx)?.command.name, "bulk_move_today");
    assert.equal(matchCommand("move all my tasks to friday", ctx)?.command.name, "bulk_move_today", "'tasks' is not a group");
    assert.equal(guardModelChoice("remove the finished ones", "bulk_complete_tag", { category: "bulk", undoable: true }, null), "forbidden");
    assert.equal(rulesUnderstand("mark the laundry done", opts).intent, "complete_task", "a completion stays one");
  });
  assert.equal(matchCommand("delete all my errands", parseCtx(opts)), null, "flag off: unchanged");
});

test("'today's X' keeps its possessive; the real date is read", () => {
  withFlag(() => {
    const e = extractEntities("review today's lecture notes tomorrow", opts);
    assert.equal(e.date?.ymd, "2026-10-06");
    const f = extractEntities("file Monday's expenses on friday", opts);
    assert.equal(f.date?.ymd, "2026-10-09");
    assert.match(f.residual, /Monday's expenses/);
  });
});

test("references match title words: 'the dentist' and a longer message find 'Dentist appointment'; generic verbs don't", async () => {
  const { wordMatch } = await import("../src/modules/assistant/draft.js");
  assert.ok(wordMatch("the dentist", "Dentist appointment") >= 0.5);
  assert.ok(wordMatch("actually dentist is 5pm", "Dentist appointment") >= 0.5);
  assert.equal(wordMatch("call plumber", "Call mom"), 0, "a shared generic verb is not a match");
  assert.equal(wordMatch("the dentist", "Buy toothpaste"), 0);
  assert.equal(wordMatch("renew gym membership by the end of the month", "Passport renewal"), 0, "one shared stem is not the task");
  assert.ok(wordMatch("reschedule my dentist thing to 5pm", "Dentist appointment") >= 0.5, "edit verbs and times don't count against it");
});

test("'evenings', 'in the mornings', 'nights' give that part of the day's time", () => {
  withFlag(() => {
    assert.equal(extractEntities("walk the dog in the evenings", opts).time, "6 PM");
    assert.equal(extractEntities("study in the mornings", opts).time, "9 AM");
    assert.equal(extractEntities("stretch nights", opts).time, "9 PM");
  });
  assert.equal(extractEntities("walk the dog in the evenings", opts).time, null, "flag off: unchanged");
});

// Whole chat, on a test user (made-up tasks).
const skip = !(await import("./fixtures.js")).dbAvailable && "no database";

test("whole chat: ranges list the right tasks, an unreadable span asks, a group move previews, a reference finds its task", { skip }, async () => {
  const { randomUUID } = await import("node:crypto");
  const { prisma } = await import("../src/config/db.js");
  const { AiService, setAi } = await import("../src/ai/llm.js");
  const { handleAssistantMessage } = await import("../src/modules/assistant/dialogue.js");
  const { zonedTimeToUtc } = await import("../src/lib/time.js");
  const { NOW, TZ } = await import("./fixtures.js"); // Monday 5 Oct 2026
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ, tier: "PRO" } });
  const due = (ymd: string, h: number) => ({ dueDate: zonedTimeToUtc(ymd, 0, 0, TZ), dueAt: zonedTimeToUtc(ymd, h, 0, TZ) });
  const task = (title: string, ymd: string, extra: Record<string, unknown> = {}) => prisma.task.create({ data: { userId: user.id, title, priority: "MEDIUM", source: "CHAT", ...due(ymd, 10), ...extra } });
  await task("Return library books", "2026-10-05");
  await task("Physics lab report", "2026-10-13");
  await task("Grocery run", "2026-10-06", { tags: ["errands"] });
  await task("Post the parcel", "2026-10-07", { tags: ["errands"] });
  await task("Dentist appointment", "2026-10-08");
  const keep = process.env.CHAT_FIXES_V2;
  process.env.CHAT_FIXES_V2 = "on";
  const say = async (text: string) => (await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, channel: "APP", now: NOW, text, payload: null, label: null })).message as { content: string; intent?: string; command?: string; cards?: unknown[] };
  try {
    const next = await say("anything due next week?");
    const shown = JSON.stringify(next.cards);
    assert.match(shown, /Physics lab report/, "next week's task is listed");
    assert.doesNotMatch(shown, /Return library books/, "today's is not");
    assert.equal((await say("what's due soon?")).intent, "query_range_ask", "an unreadable span is asked about");
    const before = await prisma.task.findMany({ where: { userId: user.id }, select: { id: true, dueAt: true } });
    const group = await say("push all my errands to friday");
    assert.equal(group.command, "bulk_move_group");
    assert.match(group.content, /Move 2 tasks in "errands"/);
    assert.deepEqual(await prisma.task.findMany({ where: { userId: user.id }, select: { id: true, dueAt: true } }), before, "nothing moves before the confirmation");
    const ref = await say("reschedule my dentist thing to 5pm");
    assert.match(ref.content, /Dentist appointment/, `the reference finds the task (${ref.intent})`);
  } finally {
    if (keep === undefined) delete process.env.CHAT_FIXES_V2;
    else process.env.CHAT_FIXES_V2 = keep;
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test("commands behind the flag can't be reached while it is off: not by name (router, buttons), not in help", async () => {
  const { getCommand, activeCommands } = await import("../src/modules/assistant/commands/registry.js");
  assert.equal(getCommand("bulk_move_group"), undefined);
  assert.equal(getCommand("bulk_delete_group"), undefined);
  assert.ok(!activeCommands().some((c) => c.name.endsWith("_group")));
  withFlag(() => assert.ok(getCommand("bulk_move_group")));
});

test("group bulk commands: nothing changes before confirmation, one undo restores everything, an expired confirmation does nothing", { skip }, async () => {
  const { randomUUID } = await import("node:crypto");
  const { prisma } = await import("../src/config/db.js");
  const { AiService, setAi } = await import("../src/ai/llm.js");
  const { handleAssistantMessage } = await import("../src/modules/assistant/dialogue.js");
  const { zonedTimeToUtc } = await import("../src/lib/time.js");
  const { CONFIRM_TTL_MS } = await import("../src/modules/assistant/commands/runtime.js");
  const { NOW, TZ } = await import("./fixtures.js");
  setAi(new AiService([]));
  const keep = process.env.CHAT_FIXES_V2;
  process.env.CHAT_FIXES_V2 = "on";
  for (const [ask, kind] of [["push all my errands to friday", "move"], ["delete all my errands", "delete"]] as const) {
    const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
    await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ, tier: "PRO" } });
    // As the app stores a timed task: dueDate (the day), dueTime and dueAt.
    const due = (ymd: string) => ({ dueDate: zonedTimeToUtc(ymd, 0, 0, TZ), dueTime: "10 AM", dueAt: zonedTimeToUtc(ymd, 10, 0, TZ) });
    await prisma.task.create({ data: { userId: user.id, title: "Grocery run", priority: "MEDIUM", source: "CHAT", tags: ["errands"], ...due("2026-10-06") } });
    await prisma.task.create({ data: { userId: user.id, title: "Post the parcel", priority: "MEDIUM", source: "CHAT", tags: ["errands"], ...due("2026-10-07") } });
    await prisma.task.create({ data: { userId: user.id, title: "Physics lab report", priority: "MEDIUM", source: "CHAT", ...due("2026-10-08") } });
    // The task as the user sees it (sync counters version / lastModifiedAt move with every change, an undo included).
    const state = async () => JSON.stringify((await prisma.task.findMany({ where: { userId: user.id }, orderBy: { title: "asc" } })).map(({ updatedAt: _u, version: _v, lastModifiedAt: _m, ...t }) => t));
    const send = async (input: { text?: string; payload?: unknown }, at = NOW) =>
      (await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, channel: "APP", now: at, text: input.text ?? null, payload: (input.payload as never) ?? null, label: null })).message as { content: string; intent?: string };
    try {
      const original = await state();
      // 1. The preview changes nothing.
      const preview = await send({ text: ask });
      assert.match(preview.content, /2 tasks in "errands"/, `${kind}: preview`);
      assert.equal(await state(), original, `${kind}: nothing changes before confirmation`);
      // 2. An expired confirmation does nothing.
      const late = await send({ payload: { type: "confirm_pending" } }, new Date(NOW.getTime() + CONFIRM_TTL_MS + 60000));
      assert.equal(late.intent, "confirm_expired", `${kind}: expired`);
      assert.equal(await state(), original, `${kind}: an expired confirmation does nothing`);
      // 3. Confirmed, it changes exactly the group; one undo restores everything.
      await send({ text: ask });
      const done = await send({ payload: { type: "confirm_pending" } });
      assert.match(done.intent ?? "", kind === "move" ? /bulk_moved/ : /bulk_deleted/);
      const changed = await prisma.task.findMany({ where: { userId: user.id } });
      const errands = changed.filter((t) => t.title !== "Physics lab report");
      if (kind === "move") assert.ok(errands.every((t) => t.dueAt?.toISOString().startsWith("2026-10-09")), "both errands on Friday");
      else assert.ok(errands.every((t) => t.status === "DELETED" || t.deletedAt), "both errands deleted");
      assert.equal(changed.find((t) => t.title === "Physics lab report")?.dueAt?.toISOString(), zonedTimeToUtc("2026-10-08", 10, 0, TZ).toISOString(), "the other task untouched");
      await send({ text: "undo" });
      assert.equal(await state(), original, `${kind}: one undo restores everything`);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  if (keep === undefined) delete process.env.CHAT_FIXES_V2;
  else process.env.CHAT_FIXES_V2 = keep;
});

test("regressions: today's to-dos still reach the bulk move; a part of the day sets AM/PM even in the title", async () => {
  const { matchCommand } = await import("../src/modules/assistant/commands/registry.js");
  withFlag(() => {
    const ctx = parseCtx(opts);
    assert.equal(matchCommand("shift today's to-dos to the 9th", ctx)?.command.name, "bulk_move_today");
    assert.equal(matchCommand("push today's stuff to thursday", ctx)?.command.name, "bulk_move_today");
    assert.equal(extractEntities("morning swim on tuesdays at 7", opts).time, "7 AM");
    assert.equal(extractEntities("breakfast with dad at 8", opts).time, "8 AM", "an 8-11 bare hour stays AM");
    assert.equal(extractEntities("evening prayer at 7", opts).time, "7 PM");
    assert.equal(extractEntities("call the bank at 4", opts).time, "4 PM", "no part of the day: the usual guess");
  });
});

test("range routing at intent detection: questions about a day or span are task questions; next N days; unreadable spans", async () => {
  const { rulesUnderstand } = await import("../src/modules/assistant/nlu.js");
  withFlag(() => {
    for (const t of ["what have I got on saturday", "anything planned for the 20th?", "plans for next weekend", "do we have anything in the next 5 days", "deadlines this month", "what's on around the holidays"]) {
      assert.equal(rulesUnderstand(t, opts).intent, "query_tasks", t);
    }
    for (const t of ["do the dishes on saturday", "submit the essay next week", "remind me on friday to pay rent"]) assert.equal(rulesUnderstand(t, opts).intent, "create_task", t);
    const r = resolveRange("do we have anything in the next 5 days", parseCtx(opts));
    assert.deepEqual(r && r !== "unknown" ? [r.from, r.to] : r, ["2026-10-05", "2026-10-10"]);
    assert.equal(resolveRange("what's on around the holidays", parseCtx(opts)), "unknown");
  });
});

test("smaller gaps: more delete verbs, an explicit request beats a feeling, 'by <day>' is a due date", async () => {
  const { rulesUnderstand } = await import("../src/modules/assistant/nlu.js");
  const { matchCommand } = await import("../src/modules/assistant/commands/registry.js");
  withFlag(() => {
    assert.equal(matchCommand("trash the completed stuff", parseCtx(opts))?.command.name, "bulk_delete_completed");
    assert.equal(rulesUnderstand("ditch the old dentist task", opts).intent, "delete_task");
    assert.equal(rulesUnderstand("clear the gutters tomorrow", opts).intent, "create_task", "'clear' is not a delete verb for the rules");
    assert.equal(rulesUnderstand("stressed out, remind me to call the dentist tomorrow", opts).intent, "create_task");
    assert.equal(rulesUnderstand("anxious again, add buy milk to my list", opts).intent, "create_task");
    assert.equal(rulesUnderstand("feeling sad today", opts).intent, "log_mood", "a feeling alone is still a mood");
    assert.equal(extractEntities("lab report needs submitting by the 20th", opts).date?.ymd, "2026-10-20");
    assert.equal(extractEntities("the history essay has to be in by thursday", opts).date?.ymd, "2026-10-08");
  });
});

test("whole chat: 'by <day>' updates a task whose title matches, and creates one when none does", { skip }, async () => {
  const { randomUUID } = await import("node:crypto");
  const { prisma } = await import("../src/config/db.js");
  const { AiService, setAi } = await import("../src/ai/llm.js");
  const { handleAssistantMessage } = await import("../src/modules/assistant/dialogue.js");
  const { zonedTimeToUtc, localYmd } = await import("../src/lib/time.js");
  const { NOW, TZ } = await import("./fixtures.js");
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ, tier: "PRO" } });
  const essay = await prisma.task.create({ data: { userId: user.id, title: "History essay", priority: "MEDIUM", source: "CHAT", dueDate: zonedTimeToUtc("2026-10-15", 0, 0, TZ), dueAt: zonedTimeToUtc("2026-10-15", 23, 59, TZ) } });
  const keep = process.env.CHAT_FIXES_V2;
  process.env.CHAT_FIXES_V2 = "on";
  const say = async (text: string) => (await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, channel: "APP", now: NOW, text, payload: null, label: null })).message as { content: string; command?: string };
  try {
    const out = await say("the history essay has to be in by thursday");
    assert.equal(out.command, "update_task", out.content);
    const after = await prisma.task.findUniqueOrThrow({ where: { id: essay.id } });
    assert.equal(after.dueAt ? localYmd(after.dueAt, TZ) : null, "2026-10-08", "moved to Thursday");
    assert.equal(await prisma.task.count({ where: { userId: user.id } }), 1, "no new task");
    const fresh = await say("the grant form must be sent by the 18th");
    assert.equal(fresh.command, "create_task", "no matching title: the create path (a deadline may ask its time)");
    assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: essay.id } })).dueAt?.toISOString(), after.dueAt?.toISOString(), "the essay is not touched");
  } finally {
    if (keep === undefined) delete process.env.CHAT_FIXES_V2;
    else process.env.CHAT_FIXES_V2 = keep;
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test("a deadline with a date but no time: created for the end of that day with a note, useful reminders, 'change time' works; no date still asks", { skip }, async () => {
  const { randomUUID } = await import("node:crypto");
  const { prisma } = await import("../src/config/db.js");
  const { AiService, setAi } = await import("../src/ai/llm.js");
  const { handleAssistantMessage } = await import("../src/modules/assistant/dialogue.js");
  const { sequenceForTask } = await import("../src/modules/reminders/reminderService.js");
  const { localParts, localYmd } = await import("../src/lib/time.js");
  const { NOW, TZ } = await import("./fixtures.js"); // Monday 5 Oct, 10:00
  setAi(new AiService([]));
  const keep = process.env.CHAT_FIXES_V2;
  process.env.CHAT_FIXES_V2 = "on";
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  const settings = await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ } });
  const say = async (text: string) => (await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, channel: "APP", now: NOW, text, payload: null, label: null })).message as { content: string; intent?: string };
  try {
    const added = await say("submit the lease form on thursday");
    assert.equal(added.intent, "task_created", added.content);
    assert.match(added.content, /Due by the end of the day\. I'll remind you earlier that day\. Say 'change time' to set a time\./);
    const task = await prisma.task.findFirstOrThrow({ where: { userId: user.id } });
    assert.equal(task.dueTime, null, "date only");
    assert.equal(localYmd(task.dueAt!, TZ), "2026-10-08");
    // Reminders: none late at night; one the day before or on the morning of the day.
    const drafts = sequenceForTask(task, settings, TZ, 9, undefined, NOW);
    assert.ok(drafts.length > 0, "it has reminders");
    for (const d of drafts) assert.ok(localParts(d.at, TZ).h < 22, `no late-night reminder (${d.at.toISOString()} ${d.body})`);
    assert.ok(drafts.some((d) => { const ymd = localYmd(d.at, TZ); const h = localParts(d.at, TZ).h; return ymd === "2026-10-07" || (ymd === "2026-10-08" && h <= 12); }), "a reminder the day before or that morning");
    // "change time", then a bare time, sets it.
    assert.match((await say("change time")).content, /What time should "Submit the lease form" be due\?/);
    await say("6 pm");
    assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).dueTime, "6 PM");
    // No date: still asks.
    const noDate = await say("submit the rent slip");
    assert.equal(noDate.intent, "clarify");
    assert.equal(await prisma.task.count({ where: { userId: user.id } }), 1);
  } finally {
    if (keep === undefined) delete process.env.CHAT_FIXES_V2;
    else process.env.CHAT_FIXES_V2 = keep;
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test("'by <day>' on an existing title: a creation verb first asks change-or-new (nothing changes); otherwise it updates", { skip }, async () => {
  const { randomUUID } = await import("node:crypto");
  const { prisma } = await import("../src/config/db.js");
  const { AiService, setAi } = await import("../src/ai/llm.js");
  const { handleAssistantMessage } = await import("../src/modules/assistant/dialogue.js");
  const { zonedTimeToUtc, localYmd } = await import("../src/lib/time.js");
  const { NOW, TZ } = await import("./fixtures.js");
  setAi(new AiService([]));
  const keep = process.env.CHAT_FIXES_V2;
  process.env.CHAT_FIXES_V2 = "on";
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ } });
  const visa = await prisma.task.create({ data: { userId: user.id, title: "Visa form", priority: "MEDIUM", source: "CHAT", dueDate: zonedTimeToUtc("2026-10-20", 0, 0, TZ), dueAt: zonedTimeToUtc("2026-10-20", 23, 59, TZ) } });
  const say = async (text: string) => (await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, channel: "APP", now: NOW, text, payload: null, label: null })).message as { content: string; intent?: string };
  try {
    const ask = await say("submit the visa form by friday");
    assert.equal(ask.intent, "change_or_new");
    assert.match(ask.content, /Change "Visa form", or add a new task\?/);
    assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: visa.id } })).dueAt?.toISOString(), visa.dueAt?.toISOString(), "nothing changes before the choice");
    assert.equal(await prisma.task.count({ where: { userId: user.id } }), 1);
    await say("the visa form has to be in by friday");
    assert.equal(localYmd((await prisma.task.findUniqueOrThrow({ where: { id: visa.id } })).dueAt!, TZ), "2026-10-09", "no verb first: updated");
  } finally {
    if (keep === undefined) delete process.env.CHAT_FIXES_V2;
    else process.env.CHAT_FIXES_V2 = keep;
    await prisma.user.delete({ where: { id: user.id } });
  }
});
