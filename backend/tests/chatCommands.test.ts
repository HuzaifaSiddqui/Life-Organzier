import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { RoutineFrequency, RoutinePriority, type User } from "@prisma/client";
import { AiService, setAi } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import { handleAssistantMessage, type Channel } from "../src/modules/assistant/dialogue.js";
import type { ActionPayload } from "../src/modules/assistant/types.js";
import { createRoutine, occurrencesForDay } from "../src/modules/routines/routineService.js";
import { localYmd } from "../src/lib/time.js";
import { dbAvailable } from "./fixtures.js";

const skip = !dbAvailable && "no database";
const TZ = "Asia/Karachi";

type Say = (text: string, channel?: Channel) => ReturnType<typeof handleAssistantMessage>;
type Tap = (payload: ActionPayload) => ReturnType<typeof handleAssistantMessage>;

/** A fresh user (rules only, AI off) talking to the real engine; removed afterwards. */
export async function withChatUser(tier: "FREE" | "PRO", fn: (say: Say, tap: Tap, user: User) => Promise<void>): Promise<void> {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, tier, timezone: TZ } });
  const settings = () => prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } });
  try {
    const say: Say = async (text, channel = "APP") => handleAssistantMessage({ user, settings: await settings(), deviceId: null, text, channel });
    const tap: Tap = async (payload) => handleAssistantMessage({ user, settings: await settings(), deviceId: null, payload, channel: "APP" });
    await fn(say, tap, user);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
}

const daily = (userId: string, title: string, extra: Partial<Parameters<typeof createRoutine>[2]> = {}) =>
  createRoutine(userId, TZ, { title, frequency: RoutineFrequency.DAILY, dueTime: "7 PM", ...extra });

test("routine commands: list, update with echo and undo", { skip }, async () => {
  await withChatUser("FREE", async (say, tap, user) => {
    await daily(user.id, "Gym workout");
    await daily(user.id, "Night reading", { dueTime: "10 PM" });

    const list = await say("show my routines");
    assert.equal(list.message.intent, "routine_list");
    assert.match(list.message.content, /Gym workout: daily at 7 PM/);

    const updated = await say("change my gym routine to 6 PM");
    assert.equal(updated.message.intent, "routine_updated");
    assert.match(updated.message.content, /at 6 PM/);
    assert.equal((await prisma.routine.findFirstOrThrow({ where: { userId: user.id, title: "Gym workout" } })).dueTime, "6 PM");

    const days = await say("make my gym routine Mon Wed Fri");
    assert.match(days.message.content, /Mon, Wed and Fri|Mon, Wed, Fri/);
    const undone = await tap({ type: "undo_command" });
    assert.equal(undone.message.intent, "undone");
    const back = await prisma.routine.findFirstOrThrow({ where: { userId: user.id, title: "Gym workout" } });
    assert.equal(back.frequency, RoutineFrequency.DAILY);
    assert.equal(back.dueTime, "6 PM");
  });
});

test("routine commands: pause and resume (Roman Urdu), 'undo' reverts the pause", { skip }, async () => {
  await withChatUser("FREE", async (say, _tap, user) => {
    const r = await daily(user.id, "Gym workout");
    const paused = await say("gym routine band kar do");
    assert.equal(paused.message.intent, "routine_paused");
    assert.equal((await prisma.routine.findUniqueOrThrow({ where: { id: r.id } })).active, false);
    assert.equal((await occurrencesForDay(user.id, TZ, localYmd(new Date(), TZ))).length, 0);
    assert.equal((await say("undo")).message.intent, "undone");
    assert.equal((await prisma.routine.findUniqueOrThrow({ where: { id: r.id } })).active, true);
    await say("pause my gym routine");
    assert.equal((await say("resume my gym routine")).message.intent, "routine_resumed");
  });
});

test("routine commands: delete asks first, 'no' keeps it, 'yes' deletes, undo restores", { skip }, async () => {
  await withChatUser("FREE", async (say, tap, user) => {
    const r = await daily(user.id, "Yoga");
    const ask = await say("delete my yoga routine");
    assert.equal(ask.message.intent, "routine_delete_confirm");
    assert.equal((await say("no")).message.intent, "cancel");
    assert.ok(await prisma.routine.findUnique({ where: { id: r.id } }));

    await say("delete my yoga routine");
    const done = await say("yes");
    assert.equal(done.message.intent, "routine_deleted");
    assert.equal(await prisma.routine.findUnique({ where: { id: r.id } }), null);

    assert.equal((await tap({ type: "undo_command" })).message.intent, "undone");
    const restored = await prisma.routine.findUniqueOrThrow({ where: { id: r.id } });
    assert.equal(restored.title, "Yoga");
  });
});

test("routine commands: several matches ask which one; a number answers", { skip }, async () => {
  await withChatUser("FREE", async (say, _tap, user) => {
    await daily(user.id, "Morning reading");
    await daily(user.id, "Night reading");
    const which = await say("pause my reading routine");
    assert.equal(which.message.intent, "command_choice");
    assert.equal(which.message.actions?.length, 2);
    const done = await say("2");
    assert.equal(done.message.intent, "routine_paused");
    assert.equal((await prisma.routine.findFirstOrThrow({ where: { userId: user.id, title: "Night reading" } })).active, false);
  });
});

test("routine commands: skip today (mandatory asks), done today, move once; each undoable", { skip }, async () => {
  await withChatUser("FREE", async (say, tap, user) => {
    await daily(user.id, "Prayer", { priority: RoutinePriority.MANDATORY, dueTime: "11:55 PM" });
    await daily(user.id, "Gym workout", { dueTime: "11:50 PM" });
    const today = localYmd(new Date(), TZ);
    const status = async (title: string) => (await occurrencesForDay(user.id, TZ, today)).find((o) => o.routine.title === title);

    assert.equal((await say("skip prayer today")).message.intent, "routine_skip_today_confirm");
    assert.equal((await say("yes")).message.intent, "routine_skipped");
    assert.equal((await status("Prayer"))?.status, "SKIPPED");
    await tap({ type: "undo_command" });
    assert.equal((await status("Prayer"))?.status, "PENDING");

    assert.equal((await say("I did my gym routine today")).message.intent, "routine_done");
    assert.equal((await status("Gym workout"))?.status, "COMPLETED");
    await say("undo");
    assert.equal((await status("Gym workout"))?.status, "PENDING");

    const moved = await say("move today's gym to 11:58 PM");
    assert.equal(moved.message.intent, "routine_rescheduled");
    assert.equal((await status("Gym workout"))?.dueTime, "11:58 PM");
    assert.equal((await prisma.routine.findFirstOrThrow({ where: { userId: user.id, title: "Gym workout" } })).dueTime, "11:50 PM");
  });
});

test("routine commands: a task name without the word routine falls back to the task", { skip }, async () => {
  await withChatUser("FREE", async (say) => {
    await say("Remind me to call Ali tomorrow at 5 PM");
    const out = await say("move today's call Ali to 6 PM");
    assert.notEqual(out.message.intent, "routine_not_found");
  });
});
