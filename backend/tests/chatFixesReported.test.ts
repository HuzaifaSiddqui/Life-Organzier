import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AiService, setAi } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import "../src/modules/assistant/commands/registry.js";
import { handleAssistantMessage } from "../src/modules/assistant/dialogue.js";
import { dbAvailable, TZ } from "./fixtures.js";

// Bugs reported from real use (30 Oct 2026), behind CHAT_FIXES_V2. Real clock: these compare with database timestamps.
const skip = !dbAvailable && "no database";

async function withUser(flag: boolean, run: (send: (text: string) => Promise<{ content: string; intent?: string }>, userId: string) => Promise<void>) {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ, tier: "PRO" } });
  const keep = process.env.CHAT_FIXES_V2;
  if (flag) process.env.CHAT_FIXES_V2 = "on";
  else delete process.env.CHAT_FIXES_V2;
  try {
    const send = async (text: string) =>
      (await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, channel: "APP", now: new Date(), text, payload: null, label: null })).message;
    await run(send, user.id);
  } finally {
    if (keep === undefined) delete process.env.CHAT_FIXES_V2;
    else process.env.CHAT_FIXES_V2 = keep;
    await prisma.user.delete({ where: { id: user.id } });
  }
}

const REPORTED = "I am a student of software engineering and Currently I am working as SQA engineer in a software house Siznam and co.\nI usually free from the university around 3 pm, \nI have a routine to go to office at 4 Pm everyday except Sunday and Saturday.";

test("the reported routine: title, time and days come from the sentence with the request", { skip }, async () => {
  await withUser(true, async (send, userId) => {
    await send(REPORTED);
    const r = await prisma.routine.findFirstOrThrow({ where: { userId } });
    assert.equal(r.title, "Go to office");
    assert.equal(r.dueTime, "4 PM");
    assert.deepEqual(r.daysOfWeek, [1, 2, 3, 4, 5]);
  });
});

test("a new variant: background sentences, then the routine with excluded days", { skip }, async () => {
  await withUser(true, async (send, userId) => {
    await send("I'm a nurse at the city hospital. I normally sleep after 11.\nI have a habit of jogging at 6:30 am every day except weekends.");
    const r = await prisma.routine.findFirstOrThrow({ where: { userId } });
    assert.match(r.title, /^jog/i);
    assert.equal(r.dueTime, "6:30 AM");
    assert.deepEqual(r.daysOfWeek, [1, 2, 3, 4, 5]);
  });
});

test("an open question unanswered for 30 quiet minutes is dropped: 'How are you today?' answers nothing", { skip }, async () => {
  for (const flag of [true, false]) {
    await withUser(flag, async (send, userId) => {
      const asked = await send("call the plumber about the leak");
      assert.match(asked.content, /When should/);
      await prisma.$executeRaw`UPDATE "Conversation" SET "updatedAt" = now() - interval '2 days' WHERE "userId" = ${userId}`;
      await send("How are you today?");
      const tasks = await prisma.task.count({ where: { userId } });
      if (flag) assert.equal(tasks, 0, "flag on: the stale question is gone, nothing created");
      else assert.equal(tasks, 1, "flag off: the bug as reported (kept for comparison)");
    });
  }
});
