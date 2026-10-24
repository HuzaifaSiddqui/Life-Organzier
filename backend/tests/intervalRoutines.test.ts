import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { User } from "@prisma/client";
import { AiService, setAi } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import { handleAssistantMessage } from "../src/modules/assistant/dialogue.js";
import { extractInterval } from "../src/modules/assistant/entities.js";
import { analyzeDocument, INTERVAL_WARNING } from "../src/modules/documents/documentProcessing.js";
import { dbAvailable } from "./fixtures.js";

const skip = !dbAvailable && "no database";
const TZ = "Asia/Karachi";
/** The reported sentence. */
const MEDICINE = "I take medicine on every alternative day, I have already taken medicine of today";

async function withUser(fn: (say: (text: string) => ReturnType<typeof handleAssistantMessage>, user: User) => Promise<void>) {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ } });
  try {
    const say = async (text: string) => handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, text, channel: "APP" });
    await fn(say, user);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
}

test("interval phrases: English and Roman Urdu, only the agreed ones", () => {
  for (const [text, n] of [
    ["take medicine every other day", 2],
    ["on alternate days", 2],
    ["alternate day gym", 2],
    [MEDICINE, 2],
    ["every 2nd day", 2],
    ["every second day", 2],
    ["water the plants every 3 days", 3],
    ["every three days", 3],
    ["every 3rd day", 3],
    ["har doosre din dawai leni hai", 2],
    ["ek din chhor kar gym", 2],
    ["har teesre din", 3],
  ] as Array<[string, number]>) assert.equal(extractInterval(text), n, text);
  for (const text of ["every day", "every Monday", "the other day I went", "alternative plan", "every 1 days", "every 40 days", "every week", "har roz"]) {
    assert.equal(extractInterval(text), null, text);
  }
});

test("chat: interval phrases get 'not supported yet' (English); nothing is created", { skip }, async () => {
  await withUser(async (say, user) => {
    for (const text of [MEDICINE, "har doosre din dawai leni hai"]) {
      const r = await say(text);
      assert.equal(r.message.intent, "interval_unsupported", text);
      assert.match(r.message.content, /isn't supported yet/);
    }
    assert.equal(await prisma.task.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.routine.count({ where: { userId: user.id } }), 0);
  });
});

test("documents: pasted text with an interval phrase says why nothing was made", async () => {
  const a = await analyzeDocument({ text: MEDICINE, fileName: "Pasted text", mimeType: "text/plain", docType: "SCHEDULE", language: "eng", tz: TZ });
  assert.equal(a.warning, INTERVAL_WARNING);
  assert.deepEqual([a.schedules.length, a.deadlines.length], [0, 0]);
});
