import assert from "node:assert/strict";
import test from "node:test";
import { AiService, setAi } from "../src/ai/llm.js";
import { appQuestionReply, distressSignal } from "../src/modules/assistant/appQuestions.js";
import { CANCEL_QUESTION, isNewRequest, isPlausibleAnswer } from "../src/modules/assistant/commands/pendingAnswer.js";
import { parseCtx } from "../src/modules/assistant/commands/registry.js";
import { refCommand, understand } from "../src/modules/assistant/nlu.js";
import { addToExistingReply, correctionTarget, OTHER_ONE } from "../src/modules/assistant/repairs.js";
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

test("review #63 (1): a name from the options is the answer, even when it starts with an action verb", async () => {
  const choose: Pending = { kind: "choose_task", purpose: "update", candidates: ["a", "b", "c", "d"], data: {} };
  const titles = ["Call mom", "Book dentist", "Plan the trip", "Finish report"];
  const ctx = parseCtx({ now: NOW, tz: TZ, contexts: [] });
  await withFixes(() => {
    for (const t of ["call mom", "book dentist", "plan the trip", "finish report"]) {
      assert.equal(isNewRequest(choose, t, ctx, titles), false, t);
      assert.equal(isPlausibleAnswer(choose, t, ctx, titles), true, t);
    }
    assert.equal(isNewRequest(choose, "add milk", ctx, titles), true, "not an option: a new request");
    const reading: Pending = { kind: "command_choice", command: "routine_update", args: {}, field: "routineId", candidates: [{ id: "r1", label: "Plan meals" }, { id: "r2", label: "Call grandma" }] };
    assert.equal(isNewRequest(reading, "call grandma", ctx), false);
    const place: Pending = { kind: "location_choice", taskId: "t", taskTitle: "x", place: "library", results: [{ name: "Book Corner", displayName: "", latitude: 0, longitude: 0 }], more: false };
    assert.equal(isNewRequest(place, "book corner", ctx), false);
  });
});

test("review #63 (2): \"can't\" is not a question; 'when I get home' answers a date question", async () => {
  const draft: Pending = { kind: "task_draft", draft: { title: "Water the plants" } as never, awaiting: ["date"], source: "CHAT", clarity: 0.5 };
  const confirm: Pending = { kind: "confirm_delete", taskId: "t", title: "x" };
  const ctx = parseCtx({ now: NOW, tz: TZ, contexts: [] });
  await withFixes(() => {
    for (const t of ["can't do it today", "cannot say yet", "couldn't tell you", "can’t right now"]) assert.equal(isNewRequest(draft, t, ctx), false, t);
    assert.equal(isNewRequest(draft, "can you show my tasks", ctx), true, "a real question still is one");
    for (const t of ["when I get home", "when I'm free", "after lunch", "before class", "by friday"]) {
      assert.equal(isNewRequest(draft, t, ctx), false, t);
      assert.equal(isPlausibleAnswer(draft, t, ctx), true, t);
    }
    assert.equal(isNewRequest(draft, "when is my dentist appointment?", ctx), true, "with '?' it is a question");
    assert.equal(isNewRequest(confirm, "when I get home", ctx), true, "not a date question: a question as before");
  });
});

test("review #63 (3): a date or time with nothing new beside it answers a date question", async () => {
  const call: Pending = { kind: "task_draft", draft: { title: "Call mom" } as never, awaiting: ["date"], source: "CHAT", clarity: 0.5 };
  const cab: Pending = { kind: "task_draft", draft: { title: "Book me a cab to the airport" } as never, awaiting: ["date"], source: "CHAT", clarity: 0.5 };
  const ctx = parseCtx({ now: NOW, tz: TZ, contexts: [] });
  await withFixes(() => {
    for (const t of ["remind me tomorrow at 5", "call her tomorrow", "make it friday", "set it for 6 pm"]) assert.equal(isNewRequest(call, t, ctx), false, t);
    assert.equal(isNewRequest(cab, "book it for friday", ctx), false);
    for (const t of ["set an alarm for 6 am", "update the report", "add milk", "call the bank tomorrow"]) assert.equal(isNewRequest(call, t, ctx), true, t);
  });
});

test("review #63 (4): 'cancel that', 'forget it' close any open question; never a delete", async () => {
  const ctx = parseCtx({ now: NOW, tz: TZ, contexts: [] });
  const bulk: Pending = { kind: "confirm_command", command: "bulk_delete", args: {}, summary: "Delete 5 tasks?" };
  await withFixes(() => {
    for (const t of ["cancel it", "cancel that", "cancel this", "forget it", "drop that", "leave it", "stop that", "no, forget about it"]) {
      assert.ok(CANCEL_QUESTION.test(t), t);
      assert.equal(isNewRequest(bulk, t, ctx), false, t);
      assert.equal(isPlausibleAnswer(bulk, t, ctx), true, t);
    }
    for (const t of ["cancel the dentist", "drop the gym routine", "stop reminding me"]) assert.ok(!CANCEL_QUESTION.test(t), t);
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

test("A3 / review #63 (5): people on an existing task only for @name or a connection; items are not people", () => {
  const people = ["sana", "ali"];
  assert.equal(addToExistingReply("add Sana to the above task", false, people)?.content, "Sharing isn't available yet.");
  assert.equal(addToExistingReply("add Sana to the above task", true, people)?.intent, "share_existing");
  assert.equal(addToExistingReply("share it with @ali", true, [])?.intent, "share_existing");
  assert.equal(addToExistingReply("add @bilal to it", true, [])?.intent, "share_existing");
  assert.equal(addToExistingReply("add Sana and Ali to this task", true, people)?.intent, "share_existing");
  for (const t of ["add milk to it", "add eggs to that task", "add Bilal to it"]) {
    const r = addToExistingReply(t, true, people);
    assert.equal(r?.intent, "add_to_task", t);
    assert.doesNotMatch(r!.content, /people/, t);
  }
  assert.equal(addToExistingReply("add milk to it", true, people)?.item, "Milk");
  for (const t of ["add milk to the list", "add Sana's birthday", "share notes with Ali tomorrow", "add milk"]) assert.equal(addToExistingReply(t, true, people), null, t);
});

test("A4: corrections and 'the other one'", () => {
  assert.equal(correctionTarget("I am not asking about task, I am asking about my completed task."), "show my completed task");
  assert.equal(correctionTarget("no, I meant the quarterly report", true), "the quarterly report", "an open question: Y is its answer");
  assert.equal(correctionTarget("no, I meant what's due tomorrow"), "what's due tomorrow");
  assert.equal(correctionTarget("I mean it"), "show it");
  assert.equal(correctionTarget("remind me what I meant to buy"), null);
  assert.equal(correctionTarget("I meant to call mom yesterday"), null, "review #63 (6): a plan, not a correction");
  assert.equal(correctionTarget("no, I meant to say friday"), null);
  for (const t of ["no, the other one", "the other one", "other task", "no, I meant the other one"]) assert.ok(OTHER_ONE.test(t), t);
  assert.ok(!OTHER_ONE.test("buy the other one tomorrow"));
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

test("review #63: through the chat: option names, cancel, items vs people", { skip: !dbAvailable && "no database" }, async () => {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ, tier: "PRO" } });
  for (const title of ["Call mom", "Call the plumber", "Old notes"]) await prisma.task.create({ data: { userId: user.id, title } });
  const conversation = await prisma.conversation.create({ data: { userId: user.id, channel: "APP", title: "t" } });
  const send = async (text: string) =>
    (await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, channel: "APP", conversationId: conversation.id, now: NOW, text } as never)).message;
  const open = () => prisma.task.count({ where: { userId: user.id, status: { not: "DELETED" } } });
  try {
    await withFixes(async () => {
      assert.equal((await send("move the call to friday")).intent, "choose_task");
      const picked = await send("call mom");
      assert.match(picked.content, /"Call mom"/, "the name picks the option, not a new 'Call mom' task");
      assert.equal(await open(), 3);
      assert.equal((await send("delete all my tasks")).intent, "bulk_delete_open_confirm");
      assert.equal((await send("cancel that")).intent, "cancel");
      assert.equal(await open(), 3, "nothing deleted");
      const milk = await send("add milk to it");
      assert.equal(milk.intent, "add_to_task");
      assert.equal(await open(), 3, "no task called 'Add milk to it'");
      // With no question open, "cancel it" is as before: the delete preview of the task in focus (nothing deleted).
      assert.equal((await send("cancel it")).intent, "confirm_delete");
      assert.equal(await open(), 3);
    });
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});
