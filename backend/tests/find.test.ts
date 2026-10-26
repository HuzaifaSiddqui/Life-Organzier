import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../src/config/db.js";
// The registry first, as in the app: it loads every command module in order.
import { parseCtx } from "../src/modules/assistant/commands/registry.js";
import { parseFindQuery } from "../src/modules/assistant/commands/find.js";
import { randomUUID } from "node:crypto";
import type { User } from "@prisma/client";
import { AiService, setAi } from "../src/ai/llm.js";
import { handleAssistantMessage } from "../src/modules/assistant/dialogue.js";
import { dbAvailable, opts } from "./fixtures.js";

const skip = !dbAvailable && "no database";

/** A fresh user talking to the real engine (rules only, AI off); removed afterwards. */
async function withChatUser(tier: "FREE" | "PRO", fn: (say: (text: string, channel?: "APP" | "WHATSAPP") => ReturnType<typeof handleAssistantMessage>, _tap: null, user: User) => Promise<void>) {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, tier, timezone: "Asia/Karachi" } });
  try {
    const say = async (text: string, channel: "APP" | "WHATSAPP" = "APP") =>
      handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, text, channel });
    await fn(say, null, user);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
}
const ctx = parseCtx(opts);
const terms = (text: string) => parseFindQuery(text, ctx)?.terms ?? null;

test("find questions: the term is read in English, Roman Urdu and spelled-out voice forms", () => {
  for (const [text, want] of [
    ["is there any task related to KFC", ["kfc"]],
    ["Is there any task related to KFC?", ["kfc"]],
    ["any task about k f c?", ["kfc"]],
    ["tasks about kay ef see", ["kfc"]],
    ["anything with Kalma Chowk", ["kalma", "chowk"]],
    ["what do I have at uni", ["uni"]],
    ["tasks about Walmart", ["walmart"]],
    ["do I have any physics tasks", ["physics"]],
    ["find my notes about the visa", ["notes", "visa"]],
    ["KFC wala kaam", ["kfc"]],
    ["KFC se related koi task hai?", ["kfc"]],
    ["KFC ke bare mein koi kaam", ["kfc"]],
  ] as Array<[string, string[]]>) assert.deepEqual(terms(text), want, text);
});

test("find questions: filters (place, date, status, priority, tag) come from the words, dates from entities.ts", () => {
  assert.equal(parseFindQuery("what do I have at uni", ctx)?.place, "uni");
  assert.equal(parseFindQuery("any task about physics due tomorrow", ctx)?.dateRange, "tomorrow");
  assert.deepEqual(parseFindQuery("tasks about physics due tomorrow", ctx)?.terms, ["physics"], "'due' is not something to look for");
  assert.equal(parseFindQuery("any overdue tasks about physics", ctx)?.dateRange, "overdue");
  assert.equal(parseFindQuery("any completed tasks about physics", ctx)?.status, "completed");
  assert.equal(parseFindQuery("any urgent task about the visa", ctx)?.priority, "URGENT");
  assert.equal(parseFindQuery("any tasks with #exam", ctx)?.tag, "exam");
});

test("not a search: doing something, a plain list question, or a new task in Roman Urdu", () => {
  for (const text of ["Add a task for KFC tomorrow at 5", "mark the KFC task done", "what's due today", "show my tasks", "any urgent tasks", "KFC wala kaam kal karna hai", "I have a task for KFC tomorrow", "task for KFC tomorrow at 5"]) {
    assert.equal(parseFindQuery(text, ctx), null, text);
  }
});

test("'is there any task related to KFC' finds the task whose place is KFC; a term with no match never shows today's list", { skip }, async () => {
  await withChatUser("PRO", async (say, _tap, user) => {
    const place = await prisma.savedLocation.create({ data: { userId: user.id, name: "KFC", displayAddress: "KFC, Kalma Chowk, Gulberg III, Lahore", latitude: 31.5, longitude: 74.3 } });
    const burger = await prisma.task.create({ data: { userId: user.id, title: "Eat burger", priority: "MEDIUM", source: "CHAT", dueAt: new Date(Date.now() + 3 * 3600000) } });
    await prisma.taskLocation.create({ data: { taskId: burger.id, savedLocationId: place.id } });
    await prisma.task.create({ data: { userId: user.id, title: "Submit physics lab", priority: "HIGH", source: "CHAT", dueAt: new Date(Date.now() + 2 * 3600000) } });

    const r = await say("is there any task related to KFC");
    assert.equal(r.message.intent, "find_items");
    assert.match(r.message.content, /Eat burger .*matched in: location/);
    assert.doesNotMatch(r.message.content, /physics/i, "today's other tasks are not listed");
    const card = r.message.cards?.find((c) => c.type === "task_list");
    assert.deepEqual(card?.type === "task_list" ? card.tasks.map((t) => t.title) : [], ["Eat burger"]);

    const none = await say("tasks about Walmart");
    assert.equal(none.message.intent, "find_items");
    assert.match(none.message.content, /couldn't find a task or routine about "walmart"/);
    assert.equal(none.message.cards?.length ?? 0, 0, "no list at all, least of all today's");
  });
});

test("WhatsApp: a plain text list, at most 8", { skip }, async () => {
  await withChatUser("PRO", async (say, _tap, user) => {
    for (let i = 1; i <= 10; i += 1) await prisma.task.create({ data: { userId: user.id, title: `Physics problem set ${i}`, priority: "MEDIUM", source: "CHAT" } });
    const r = await say("any task about physics", "WHATSAPP");
    assert.equal(r.message.intent, "find_items");
    assert.equal(r.message.cards?.length ?? 0, 0);
    assert.equal(r.message.content.split("\n").filter((l) => l.startsWith("• ")).length, 8);
  });
});

test("Urdu users get the reply in Urdu", { skip }, async () => {
  await withChatUser("PRO", async (say, _tap, user) => {
    await prisma.userSettings.update({ where: { userId: user.id }, data: { language: "ur" } });
    await prisma.task.create({ data: { userId: user.id, title: "KFC coupons", priority: "LOW", source: "CHAT" } });
    assert.match((await say("KFC wala kaam")).message.content, /سے ملتے 1 کام/);
    assert.match((await say("tasks about Walmart")).message.content, /کوئی کام یا روٹین نہیں ملی/);
  });
});

test("each result says where it matched: notes, title, a misspelling, spelled-out letters, a routine", { skip }, async () => {
  await withChatUser("PRO", async (say, _tap, user) => {
    await prisma.task.create({ data: { userId: user.id, title: "Pick up coupons", description: "the kfc deal ends Friday", priority: "LOW", source: "CHAT" } });
    await prisma.task.create({ data: { userId: user.id, title: "Read about Kentucky history", priority: "LOW", source: "CHAT" } });
    await prisma.routine.create({ data: { userId: user.id, title: "Gym workout", location: "Shapes Gym", frequency: "DAILY", dueTime: "7 PM" } });

    const notes = await say("is there any task related to KFC");
    assert.match(notes.message.content, /Pick up coupons .*matched in: notes/);
    assert.doesNotMatch(notes.message.content, /Kentucky/, "KFC is not Kentucky");
    for (const spelled of ["any task about k f c", "tasks about kay ef see"]) assert.match((await say(spelled)).message.content, /Pick up coupons .*matched in: notes/, spelled);

    assert.match((await say("any task about Kentucky")).message.content, /Read about Kentucky history .*matched in: title/);
    assert.match((await say("any task about kentuky")).message.content, /Read about Kentucky history .*matched in: title/, "misspelling (same sound)");

    const gym = await say("anything with Shapes Gym");
    assert.ok(gym.message.content.includes("• Gym workout (routine, daily at 7 PM) · matched in: title / location"), gym.message.content);
    assert.ok(gym.message.cards?.some((c) => c.type === "routine"), "routine card");
  });
});

test("'when is my physics task due?' is the single-task due answer, not a search list", { skip }, async () => {
  await withChatUser("PRO", async (say, _tap, user) => {
    await prisma.task.create({ data: { userId: user.id, title: "Physics assignment", priority: "MEDIUM", source: "CHAT", dueAt: new Date(Date.now() + 26 * 3600000) } });
    await prisma.task.create({ data: { userId: user.id, title: "Buy groceries", priority: "LOW", source: "CHAT", dueAt: new Date(Date.now() + 5 * 3600000) } });
    for (const text of ["when is my physics task due?", "when is the physics assignment due"]) {
      assert.equal(parseFindQuery(text, ctx), null, `${text}: not a find question`);
      const r = await say(text);
      assert.notEqual(r.message.intent, "find_items", text);
      assert.match(r.message.content, /Physics assignment/, text);
      assert.doesNotMatch(r.message.content, /groceries|Found \d/i, `${text}: one task, no list`);
    }
  });
});
