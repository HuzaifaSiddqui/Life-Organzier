import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AiService, setAi } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import { zonedTimeToUtc } from "../src/lib/time.js";
import "../src/modules/assistant/commands/registry.js";
import { handleAssistantMessage } from "../src/modules/assistant/dialogue.js";
import { dbAvailable, NOW, TZ } from "./fixtures.js";

// New scenarios (none from the held-out set). CHAT_FIXES_V2 resolves "the X" against the user's own items.
const skip = !dbAvailable && "no database";
/** Today's (the pinned NOW's) occurrence, as the routine service would have generated it. */
const occurrenceToday = (userId: string, routineId: string, dueTime: string) =>
  prisma.routineOccurrence.create({ data: { userId, routineId, occurrenceDate: zonedTimeToUtc("2026-10-05", 0, 0, TZ), dueTime } });

async function withUser(flag: boolean, run: (send: (text: string) => Promise<{ content: string; intent?: string }>, userId: string) => Promise<void>) {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ, tier: "PRO" } });
  const keep = process.env.CHAT_FIXES_V2;
  if (flag) process.env.CHAT_FIXES_V2 = "on";
  else delete process.env.CHAT_FIXES_V2;
  try {
    const send = async (text: string) =>
      (await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, channel: "APP", now: NOW, text, payload: null, label: null })).message;
    await run(send, user.id);
  } finally {
    if (keep === undefined) delete process.env.CHAT_FIXES_V2;
    else process.env.CHAT_FIXES_V2 = keep;
    await prisma.user.delete({ where: { id: user.id } });
  }
}

test("E: 'took the pills' marks the user's pills routine done today; nothing is created", { skip }, async () => {
  await withUser(true, async (send, userId) => {
    const r = await prisma.routine.create({ data: { userId, title: "Take blood pressure pills", frequency: "DAILY", dueTime: "9 PM", createdAt: new Date("2026-09-01T00:00:00Z") } });
    await occurrenceToday(userId, r.id, "9 PM");
    await send("took the pills");
    assert.equal(await prisma.routine.count({ where: { userId } }), 1, "no new routine");
    assert.equal(await prisma.task.count({ where: { userId } }), 0, "no task");
    const done = await prisma.routineOccurrence.count({ where: { routine: { userId }, status: "COMPLETED" } });
    assert.equal(done, 1, "today's occurrence is done");
  });
});

test("h-102 class: moving a routine's session today reschedules that occurrence, not a task", { skip }, async () => {
  await withUser(true, async (send, userId) => {
    const r = await prisma.routine.create({ data: { userId, title: "Morning yoga", frequency: "DAILY", dueTime: "7 AM", createdAt: new Date("2026-09-01T00:00:00Z") } });
    await occurrenceToday(userId, r.id, "7 AM");
    const out = await send("move today's yoga to 7 pm");
    assert.equal(await prisma.task.count({ where: { userId } }), 0, "no task created or edited");
    assert.doesNotMatch(out.content, /couldn't find a task/i);
    const occ = await prisma.routineOccurrence.findMany({ where: { routineId: r.id }, select: { dueTime: true } });
    assert.ok(occ.some((o) => o.dueTime === "7:00 PM" || o.dueTime === "7 PM"), `today's session moved to 7 PM (${JSON.stringify(occ)})`);
    assert.equal((await prisma.routine.findUniqueOrThrow({ where: { id: r.id } })).dueTime, "7 AM", "the routine itself unchanged");
  });
});

test("C: a change said about an existing task asks 'change or new' instead of adding a duplicate", { skip }, async () => {
  await withUser(true, async (send, userId) => {
    await prisma.task.create({ data: { userId, title: "Budget meeting", priority: "MEDIUM", source: "CHAT", dueAt: zonedTimeToUtc("2026-10-06", 15, 0, TZ), dueDate: zonedTimeToUtc("2026-10-06", 0, 0, TZ) } });
    const out = await send("the budget meeting is now at 4pm instead");
    assert.equal(out.intent, "change_or_new");
    assert.equal(await prisma.task.count({ where: { userId } }), 1, "no duplicate");
  });
});

test("flag off: the same messages behave as before (no routine lookup, no change question)", { skip }, async () => {
  await withUser(false, async (send, userId) => {
    await prisma.task.create({ data: { userId, title: "Budget meeting", priority: "MEDIUM", source: "CHAT", dueAt: zonedTimeToUtc("2026-10-06", 15, 0, TZ), dueDate: zonedTimeToUtc("2026-10-06", 0, 0, TZ) } });
    const out = await send("the budget meeting is now at 4pm instead");
    assert.notEqual(out.intent, "change_or_new");
  });
});
