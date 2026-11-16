import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AiService, setAi } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import "../src/modules/assistant/commands/registry.js";
import { handleAssistantMessage, spokenMemory } from "../src/modules/assistant/dialogue.js";
import { dbAvailable, TZ } from "./fixtures.js";

/** "Got it — I'll remember that …" says a memory back in the second person (the \b fix from bd855f2). Seeded sentences. */
const NEVER = /\byou (?:prefers|dislikes|works|listens|likes|is)\b|\bthe user\b/i;

test("spokenMemory: 'you prefer', 'your', 'you are'; never 'you prefers', 'the user's', 'you is'", () => {
  const cases: Array<[string, string]> = [
    ["User prefers revising in the library", "you prefer revising in the library"],
    ["User dislikes group calls after 9 PM", "you dislike group calls after 9 PM"],
    ["User works best before lunch", "you work best before lunch"],
    ["User listens to qawwali when studying", "you listen to qawwali when studying"],
    ["User likes to be called Sana", "you like to be called Sana"],
    ["User's goal is to finish the thesis by March", "your goal is to finish the thesis by March"],
    ["User is a pharmacy student at UHS", "you are a pharmacy student at UHS"],
    ["Green tea helps the user feel better", "Green tea helps you feel better"],
    ["Exams are when the user's sleep suffers", "Exams are when your sleep suffers"],
  ];
  for (const [stored, said] of cases) {
    assert.equal(spokenMemory(stored), said);
    assert.doesNotMatch(spokenMemory(stored), NEVER, stored);
  }
});

test("chat: 'I'll remember that you prefer … / your … / you are …'", { skip: !dbAvailable && "no database" }, async () => {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ, tier: "PRO" } });
  const conversation = await prisma.conversation.create({ data: { userId: user.id, channel: "APP", title: "t" } });
  const send = async (text: string) =>
    (await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, channel: "APP", conversationId: conversation.id, now: new Date("2026-11-12T12:00:00Z"), text, payload: null, label: null } as never)).message;
  try {
    for (const [say, heard] of [
      ["I prefer revising in the library", "I'll remember that you prefer revising in the library."],
      ["my goal is to finish the thesis by March", "I'll remember that your goal is to finish the thesis by March."],
      ["I'm a pharmacy student at UHS", "I'll remember that you are a pharmacy student at UHS."],
    ]) {
      const m = await send(say);
      assert.equal(m.intent, "provide_info", say);
      assert.ok(m.content.includes(heard), `${say} → ${m.content}`);
      assert.doesNotMatch(m.content, NEVER);
    }
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});
