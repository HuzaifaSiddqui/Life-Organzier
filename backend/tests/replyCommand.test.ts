import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AiService, setAi } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import { COMMANDS, getCommand } from "../src/modules/assistant/commands/registry.js";
import type { Turn } from "../src/modules/assistant/dialogue.js";
import { emptyState } from "../src/modules/assistant/types.js";
import { handleIntent } from "../src/modules/assistant/handlers.js";
import { rulesUnderstand, type Understanding } from "../src/modules/assistant/nlu.js";
import { dbAvailable, NOW, TZ } from "./fixtures.js";

// Every reply says which command handled it (internal, for evaluation and the action contract). A wrapped command
// dispatched by handleIntent must report itself, or the command it handed off to.
const skip = !dbAvailable && "no database";

test("every wrapped command's reply carries its command", { skip }, async () => {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  const settings = await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ, tier: "PRO" } });
  const conversation = await prisma.conversation.create({ data: { userId: user.id, channel: "APP" } });
  await prisma.task.create({ data: { userId: user.id, title: "Essay draft", priority: "MEDIUM", source: "CHAT" } });
  try {
    const wrapped = COMMANDS.filter((c) => c.wrapped);
    assert.ok(wrapped.length >= 10, "the registry lists the wrapped intents");
    for (const command of wrapped) {
      const text = command.examples[0] ?? command.name;
      const turn: Turn = {
        user,
        settings,
        tz: TZ,
        now: NOW,
        todayYmd: "2026-10-05",
        channel: "APP",
        source: "CHAT",
        conversation,
        state: emptyState(),
        history: [],
        task: { userId: user.id, tz: TZ },
        learned: [],
        memoriesUsed: 0,
      };
      const u: Understanding = { ...rulesUnderstand(text, { now: NOW, timezone: TZ } as never), intent: command.name as Understanding["intent"] };
      const out = await handleIntent(turn, u, text);
      assert.ok(out.command, `${command.name} ("${text}") → reply "${out.intent}" carries no command`);
      assert.ok(getCommand(out.command), `${command.name}: "${out.command}" is a registry command`);
    }
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});
