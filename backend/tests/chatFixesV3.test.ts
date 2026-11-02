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
