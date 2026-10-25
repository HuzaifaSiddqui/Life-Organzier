import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/config/db.js";
// The registry first, as in the app: it loads every command module in order.
import "../src/modules/assistant/commands/registry.js";
import { AiService, setAi } from "../src/ai/llm.js";
import { handleAssistantMessage } from "../src/modules/assistant/dialogue.js";
import { detectMood } from "../src/modules/mood/moodService.js";
import { dbAvailable } from "./fixtures.js";

const skip = !dbAvailable && "no database";

test("venting about sleep is a mood, not a task", () => {
  assert.equal(detectMood("I don't want to do any task, I just want sleep")?.mood, "tired");
  assert.equal(detectMood("remind me to sleep at 11 PM"), null);
});

// Phone test 2026-10-25: each of these went wrong in the app (rules only, AI off here).
test("phone-test misreads: mandatory button, delete all open, 'get me' search", { skip }, async () => {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, tier: "PRO", timezone: "Asia/Karachi" } });
  const say = async (text: string) =>
    (await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, text, channel: "APP" })).message;
  try {
    await say("Go to KFC today at 4 PM");
    await say("Call mom's doctor today");
    await say("Go to gym every Tuesday and Friday at 9 AM");
    await say("Gym bag check every day at 8 PM"); // a second routine that also says "gym"

    const mandatory = await say("Make Go to gym mandatory");
    assert.equal(mandatory.intent, "routine_updated", mandatory.content);
    assert.equal((await prisma.routine.findFirstOrThrow({ where: { userId: user.id, title: "Go to gym" } })).priority, "MANDATORY");

    const found = await say("Get me a task related to KFc");
    assert.match(found.content, /Go to KFC/);
    assert.doesNotMatch(found.content, /Call mom/);

    const ask = await say("Please remove all the pending tasks");
    assert.match(ask.content, /Delete 2 open tasks\?/);
    assert.equal(await prisma.task.count({ where: { userId: user.id, status: { not: "DELETED" } } }), 2, "nothing goes before the yes");
    assert.match((await say("yes")).content, /Deleted 2 open tasks/);
    assert.equal(await prisma.task.count({ where: { userId: user.id, status: { not: "DELETED" } } }), 0);
    await say("undo");
    assert.equal(await prisma.task.count({ where: { userId: user.id, status: { not: "DELETED" } } }), 2);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});
