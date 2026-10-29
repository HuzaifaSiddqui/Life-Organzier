import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AiService, setAi } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import "../src/modules/assistant/commands/registry.js";
import { handleAssistantMessage } from "../src/modules/assistant/dialogue.js";
import { bareImperative } from "../src/modules/assistant/nlu.js";
import { extractEntities } from "../src/modules/assistant/entities.js";
import { dbAvailable, NOW, TZ } from "./fixtures.js";

const e = (t: string) => extractEntities(t, { now: NOW, tz: TZ });

test("bare imperative: a verb, no task cue, no date / time / duration / repeat", () => {
  for (const t of ["book me a taxi to the airport", "call my mother", "order a pizza for dinner", "send a text to John saying I'm late"]) assert.equal(bareImperative(t, e(t)), true, t);
  for (const t of ["remind me to call my mother", "call my mother tomorrow at 6", "add task: order a pizza", "I need to book flights", "what's the weather tomorrow"]) assert.equal(bareImperative(t, e(t)), false, t);
});

test("OOS_CONFIRM: on, a bare imperative asks and creates nothing; the button starts the task flow; off, unchanged", { skip: !dbAvailable && "no database" }, async () => {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ, tier: "PRO" } });
  const keep = process.env.OOS_CONFIRM;
  const send = async (input: { text?: string; payload?: unknown; label?: string }) =>
    (await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, channel: "APP", now: NOW, text: input.text ?? null, payload: (input.payload ?? null) as never, label: input.label ?? null })).message;
  const tasks = () => prisma.task.count({ where: { userId: user.id } });
  try {
    process.env.OOS_CONFIRM = "on";
    const asked = await send({ text: "book me a taxi to the airport" });
    assert.match(asked.content, /can't do that myself/);
    assert.equal(await tasks(), 0, "nothing created");
    const button = (asked.actions ?? []).find((a) => a.label === "Add as a task");
    assert.ok(button);
    const tapped = await send({ payload: button.payload, label: button.label });
    assert.equal(tapped.intent, "clarify", "the tap starts the normal task flow (it asks when)");
    const noDeadline = (tapped.actions ?? []).find((a) => a.label === "No deadline");
    assert.ok(noDeadline);
    await send({ payload: noDeadline.payload, label: noDeadline.label });
    assert.equal(await tasks(), 1, "added after the usual question");
    delete process.env.OOS_CONFIRM;
    const direct = await send({ text: "call my mother" });
    assert.notEqual(direct.intent, "out_of_scope", "flag off: the usual task flow, as today");
    assert.doesNotMatch(direct.content, /can't do that myself/);
  } finally {
    if (keep === undefined) delete process.env.OOS_CONFIRM;
    else process.env.OOS_CONFIRM = keep;
    await prisma.user.delete({ where: { id: user.id } });
  }
});
