import assert from "node:assert/strict";
import test from "node:test";
import { AiService, setAi } from "../src/ai/llm.js";
import { appQuestionReply, distressSignal } from "../src/modules/assistant/appQuestions.js";
import { isNewRequest } from "../src/modules/assistant/commands/pendingAnswer.js";
import { parseCtx } from "../src/modules/assistant/commands/registry.js";
import { refCommand, understand } from "../src/modules/assistant/nlu.js";
import { CANCEL_CHOICE, correctionTarget, OTHER_ONE, shareExistingReply } from "../src/modules/assistant/repairs.js";
import { detectMood } from "../src/modules/mood/moodService.js";
import type { Pending } from "../src/modules/assistant/types.js";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/config/db.js";
import "../src/modules/assistant/commands/registry.js";
import { handleAssistantMessage } from "../src/modules/assistant/dialogue.js";
import { dbAvailable, NOW, opts, TZ } from "./fixtures.js";

/** PR A of the 29-message chat probe (CHAT_FIXES_V2). */
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

test("A1: app identity and privacy questions get fixed answers; other messages don't", () => {
  for (const t of ["who made you?", "Who are you", "are you a bot?", "who built you"]) assert.equal(appQuestionReply(t)?.intent, "app_identity", t);
  for (const t of ["is my data private?", "who can see my tasks?", "what do you do with my data", "do you sell my data?"]) assert.equal(appQuestionReply(t)?.intent, "app_privacy", t);
  for (const t of ["who made the cake for the party", "make my data report private by friday", "remind me who to call"]) assert.equal(appQuestionReply(t), null, t);
  assert.match(appQuestionReply("is my data private?")!.content, /Settings → Data & account/);
  assert.doesNotMatch(appQuestionReply("is my data private?")!.content, /encrypt|qwen|ollama|gemini/i, "no claims it can't back, no model names");
});

test("A1: the distress guard: these say the user is struggling (a model's 'support' stands)", () => {
  const results = ["I'm overwhelmed", "I can't cope", "I don't want to do anything today", "I feel like giving up on everything"].map((t) => [t, distressSignal(t, detectMood(t))] as const);
  for (const [t, hit] of results) assert.equal(hit, true, t);
  for (const t of ["is my data private?", "who made you?", "what's the weather like in Lahore?"]) assert.equal(distressSignal(t, detectMood(t)), false, t);
});

test("A1: a model's 'support' without distress in the message is not taken; with distress it is", async () => {
  setAi(new AiService([{ name: "fake", chat: async () => JSON.stringify({ intent: "support", task_title: "", target_task: "", mood: "none" }) }]));
  const ask = (text: string) => understand(text, { ...opts, history: [], allowLlm: true });
  await withFixes(async () => {
    assert.notEqual((await ask("is my data safe with you guys")).intent, "support");
    assert.equal((await ask("I feel like giving up on everything")).intent, "support");
  });
  setAi(new AiService([]));
});

test("A2: a new request replaces an open date question; a back-reference with a date still answers it", async () => {
  const draft: Pending = { kind: "task_draft", draft: { title: "Book me a cab to the airport" } as never, awaiting: ["date"], source: "CHAT", clarity: 0.5 };
  const choose: Pending = { kind: "choose_task", purpose: "update", candidates: ["a", "b"], data: {} };
  const ctx = (_t: string) => parseCtx({ now: NOW, tz: TZ, contexts: [] });
  await withFixes(() => {
    for (const t of ["make it friday", "set it for 6 pm", "do it tomorrow", "do it tomorrow at 5 pm", "put it on monday", "tomorrow", "6 pm", "yes", "2"]) assert.equal(isNewRequest(draft, t, ctx(t)), false, t);
    for (const t of ["set an alarm for 6 am", "update the report", "add milk", "what's due this week?"]) assert.equal(isNewRequest(draft, t, ctx(t)), true, t);
    assert.equal(isNewRequest(choose, "2", ctx("2")), false);
    assert.equal(isNewRequest(choose, "add milk", ctx("add milk")), true);
  });
});

test("A3: a command verb on a reference edits a task; it never names a new one", () => {
  const cases: Array<[string, string | null]> = [
    ["complete the second one", "complete_task"],
    ["finish it", "complete_task"],
    ["delete that one", "delete_task"],
    ["move the first to monday", "update_task"],
    ["update it to 5 pm", "update_task"],
    ["complete the essay", null],
    ["finish the slides by friday", null],
    ["add milk", null],
    ["update the report", "update_task"],
    ["edit my essay", "update_task"],
    ["change the bedsheets", null],
  ];
  for (const [t, want] of cases) assert.equal(refCommand(t), want, t);
});

test("A3: adding people to an existing task is explained, never a new task", () => {
  assert.equal(shareExistingReply("add Sana to the above task", false), "Sharing isn't available yet.");
  assert.match(shareExistingReply("share it with @ali", true)!, /@sana/);
  assert.match(shareExistingReply("add Sana and Ali to this task", true)!, /already exists/);
  for (const t of ["add milk to the list", "add Sana's birthday", "share notes with Ali tomorrow"]) assert.equal(shareExistingReply(t, true), null, t);
});

test("A4: corrections and 'the other one'", () => {
  assert.equal(correctionTarget("I am not asking about task, I am asking about my completed task."), "show my completed task");
  assert.equal(correctionTarget("no, I meant the quarterly report", true), "the quarterly report", "an open question: Y is its answer");
  assert.equal(correctionTarget("no, I meant what's due tomorrow"), "what's due tomorrow");
  assert.equal(correctionTarget("I mean it"), "show it");
  assert.equal(correctionTarget("remind me what I meant to buy"), null);
  for (const t of ["no, the other one", "the other one", "other task", "no, I meant the other one"]) assert.ok(OTHER_ONE.test(t), t);
  assert.ok(!OTHER_ONE.test("buy the other one tomorrow"));
  for (const t of ["never mind", "cancel", "no, forget it"]) assert.ok(CANCEL_CHOICE.test(t), t);
  assert.ok(!CANCEL_CHOICE.test("cancel the dentist"));
});

test("A3: 'update the X' edits a task named X; with no such task it is still a new to-do", { skip: !dbAvailable && "no database" }, async () => {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ, tier: "PRO" } });
  await prisma.task.create({ data: { userId: user.id, title: "Project report" } });
  const send = async (text: string) =>
    (await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, channel: "APP", now: NOW, text, payload: null, label: null })).message;
  try {
    await withFixes(async () => {
      assert.equal((await send("update the report")).intent, "update_ask", "asks what to change in Project report");
      const site = await send("update the website");
      assert.notEqual(site.intent, "not_found");
      assert.ok(["clarify", "task_created"].includes(site.intent ?? ""), site.intent);
      assert.equal(await prisma.task.count({ where: { userId: user.id, title: "Project report" } }), 1);
    });
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});
