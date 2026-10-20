import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { RoutineFrequency, RoutinePriority, type User } from "@prisma/client";
import { AiService, setAi } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import { handleAssistantMessage, type Channel } from "../src/modules/assistant/dialogue.js";
import type { ActionPayload } from "../src/modules/assistant/types.js";
import { createRoutine, occurrencesForDay } from "../src/modules/routines/routineService.js";
import { addDaysYmd, localYmd } from "../src/lib/time.js";
import { streakFromDays } from "../src/modules/analytics/analyticsService.js";
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
  const fresh = () => prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  try {
    const say: Say = async (text, channel = "APP") => handleAssistantMessage({ user: await fresh(), settings: await settings(), deviceId: null, text, channel });
    const tap: Tap = async (payload) => handleAssistantMessage({ user: await fresh(), settings: await settings(), deviceId: null, payload, channel: "APP" });
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

const taskNamed = async (userId: string, title: string) => prisma.task.findFirstOrThrow({ where: { userId, title } });

test("task commands: note, reminder mode, tags and category, each echoed and undoable", { skip }, async () => {
  await withChatUser("FREE", async (say, tap, user) => {
    await say("Submit the essay by Friday 5 PM");
    const essay = await taskNamed(user.id, "Submit the essay");

    assert.equal((await say("add a note to the essay: bring printouts")).message.intent, "task_note_added");
    assert.equal((await taskNamed(user.id, "Submit the essay")).description, "bring printouts");
    await tap({ type: "undo_command" });
    assert.equal((await taskNamed(user.id, "Submit the essay")).description, null);

    const mode = await say("turn off reminders for the essay");
    assert.equal(mode.message.intent, "task_reminder_mode");
    assert.match(mode.message.content, /no reminders/);
    assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: essay.id } })).reminderMode, "NONE");

    await say("add tag uni to the essay");
    assert.deepEqual((await prisma.task.findUniqueOrThrow({ where: { id: essay.id } })).tags, ["uni"]);
    assert.match((await say("remove the tag physics from the essay")).message.content, /doesn't have the tag #physics/);
    await say("essay se uni ka tag hata do");
    assert.deepEqual((await prisma.task.findUniqueOrThrow({ where: { id: essay.id } })).tags, []);

    assert.equal((await say("put the essay in the Spaceship category")).message.intent, "category_unknown");
    assert.equal((await say("put the essay in the academic category")).message.intent, "task_category_updated");
    assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: essay.id } })).category, "Academic");
  });
});

test("task commands: start, reopen, and a new task when the name matches nothing", { skip }, async () => {
  await withChatUser("FREE", async (say, _tap, user) => {
    await say("Submit the essay by Friday 5 PM");
    assert.equal((await say("start the essay")).message.intent, "task_started");
    assert.equal((await taskNamed(user.id, "Submit the essay")).status, "IN_PROGRESS");
    await say("I finished the essay");
    assert.equal((await taskNamed(user.id, "Submit the essay")).status, "COMPLETED");
    assert.equal((await say("reopen the essay")).message.intent, "task_reopened");
    assert.equal((await taskNamed(user.id, "Submit the essay")).status, "PENDING");
    assert.equal((await say("reopen the essay")).message.intent, "task_reopen"); // already open

    const fresh = await say("start studying physics");
    assert.notEqual(fresh.message.intent, "not_found");
  });
});

test("task commands: add, list and complete subtasks; undo removes the added ones", { skip }, async () => {
  await withChatUser("FREE", async (say, tap, user) => {
    await say("Finish the project by Friday 5 PM");
    const project = await taskNamed(user.id, "Finish the project");
    const added = await say("add subtasks to the project: research, draft and review");
    assert.equal(added.message.intent, "subtasks_added");
    assert.equal(await prisma.task.count({ where: { parentTaskId: project.id, status: { not: "DELETED" } } }), 3);

    const list = await say("show the subtasks of the project");
    assert.match(list.message.content, /0\/3 done\n1\. Research\n2\. Draft\n3\. Review/);
    assert.equal((await say("mark step 2 of the project as done")).message.intent, "task_completed");
    assert.equal((await taskNamed(user.id, "Draft")).status, "COMPLETED");
    assert.equal((await say("complete the review subtask of the project")).message.intent, "task_completed");

    await say("add a subtask to the project: submit");
    await tap({ type: "undo_command" });
    assert.equal(await prisma.task.count({ where: { parentTaskId: project.id, status: { not: "DELETED" } } }), 3);
  });
});

test("settings commands: quiet hours, DND, language; new value echoed, undo restores", { skip }, async () => {
  await withChatUser("FREE", async (say, tap, user) => {
    const s = () => prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } });
    assert.match((await say("what are my quiet hours?")).message.content, /10 PM to 8 AM/);
    const set = await say("quiet hours raat 11 se subah 7 tak kar do");
    assert.equal(set.message.intent, "settings_quiet_hours_set");
    assert.match(set.message.content, /11 PM to 7 AM/);
    assert.deepEqual([(await s()).quietStart, (await s()).quietEnd], ["23:00", "07:00"]);
    await tap({ type: "undo_command" });
    assert.deepEqual([(await s()).quietStart, (await s()).quietEnd], ["22:00", "08:00"]);

    const on = await say("do not disturb for 2 hours");
    assert.equal(on.message.intent, "settings_dnd_on");
    const until = (await s()).dndUntil as Date;
    assert.ok(Math.abs(until.getTime() - Date.now() - 2 * 3600000) < 60000);
    assert.match((await say("is do not disturb on?")).message.content, /on until/);
    assert.equal((await say("turn off DND")).message.intent, "settings_dnd_off");
    assert.equal((await s()).dndUntil, null);
    await say("undo");
    assert.ok((await s()).dndUntil);

    const ur = await say("switch to Urdu");
    assert.equal(ur.message.intent, "settings_language_set");
    assert.match(ur.message.content, /اردو/);
    assert.equal((await s()).language, "ur");
    await tap({ type: "undo_command" });
    assert.equal((await s()).language, "en");
    assert.match((await say("show my settings")).message.content, /Quiet hours: 10 PM to 8 AM/);
  });
});

test("settings commands: WhatsApp reminders need Pro and a linked number", { skip }, async () => {
  await withChatUser("FREE", async (say) => {
    assert.equal((await say("send my reminders to WhatsApp only")).message.intent, "settings_pro_only");
  });
  await withChatUser("PRO", async (say, _tap, user) => {
    assert.equal((await say("send my reminders to WhatsApp only")).message.intent, "settings_whatsapp_unlinked");
    await prisma.user.update({ where: { id: user.id }, data: { phoneNumber: `+92300${Math.floor(1000000 + Math.random() * 8999999)}`, phoneVerifiedAt: new Date() } });
    assert.equal((await say("reminders whatsapp pe bhejo")).message.intent, "settings_notify_devices_set");
    assert.equal((await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } })).notificationDevices, "WHATSAPP");
    const both = await say("remind me on both phone and WhatsApp");
    assert.equal(both.message.intent, "settings_notify_devices_set");
    assert.equal((await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } })).notificationDevices, "ALL");
    assert.match((await say("where do my reminders go?")).message.content, /phone and WhatsApp/);
  });
});

test("insights: streak counts days in a row, alive until today ends", () => {
  const today = "2026-10-05";
  const days = (...ymds: string[]) => new Set(ymds);
  assert.deepEqual(streakFromDays(days(), today), { days: 0, includesToday: false });
  assert.deepEqual(streakFromDays(days(today, "2026-10-04", "2026-10-03", "2026-10-01"), today), { days: 3, includesToday: true });
  assert.deepEqual(streakFromDays(days("2026-10-04", "2026-10-03"), today), { days: 2, includesToday: false });
  assert.deepEqual(streakFromDays(days("2026-10-03"), today), { days: 0, includesToday: false });
});

test("insights commands: completed, overdue, time per category, streak, compare, from real data", { skip }, async () => {
  await withChatUser("FREE", async (say, _tap, user) => {
    const now = new Date();
    const today = localYmd(now, TZ);
    const mk = (title: string, extra: Record<string, unknown>) => prisma.task.create({ data: { userId: user.id, title, priority: "MEDIUM", source: "CHAT", ...extra } });
    await mk("Essay", { status: "COMPLETED", completedAt: now, category: "Academic", durationMinutes: 90 });
    await mk("Lab", { status: "COMPLETED", completedAt: new Date(now.getTime() - 86400000), category: "Academic", durationMinutes: 60 });
    await mk("Rent", { status: "COMPLETED", completedAt: now, category: "Finance" });
    await mk("Old quiz", { status: "PENDING", dueAt: new Date(now.getTime() - 3 * 86400000), dueDate: new Date(`${addDaysYmd(today, -3)}T00:00:00Z`) });

    assert.match((await say("how many tasks did I complete this week?")).message.content, /completed 3 tasks in the last 7 days/);
    assert.match((await say("how many tasks are overdue?")).message.content, /^1 task is overdue/);
    const time = await say("how much time did I spend on Academic this week?");
    assert.match(time.message.content, /Academic: 2h 30m across 2 tasks/);
    assert.match((await say("what's my streak?")).message.content, /^2 days in a row/);
    assert.match((await say("how did I do compared to last week?")).message.content, /Last 7 days: 3 tasks done/);
  });
});

test("bulk: move all of today previews titles, one yes moves them, undo moves them back", { skip }, async () => {
  await withChatUser("FREE", async (say, tap, user) => {
    const today = localYmd(new Date(), TZ);
    const mkToday = (title: string) => prisma.task.create({ data: { userId: user.id, title, priority: "MEDIUM", source: "CHAT", dueDate: new Date(`${today}T00:00:00Z`), dueTime: "11:59 PM", dueAt: new Date(Date.now() + 3600000) } });
    await mkToday("Read chapter 3");
    await mkToday("Email the TA");
    const ask = await say("move all of today's tasks to tomorrow");
    assert.equal(ask.message.intent, "bulk_move_today_confirm");
    assert.match(ask.message.content, /^Move 2 tasks from today to tomorrow\?\n• /);
    assert.match(ask.message.content, /Read chapter 3/);
    assert.equal((await say("yes")).message.intent, "bulk_moved");
    const moved = await prisma.task.findMany({ where: { userId: user.id } });
    assert.ok(moved.every((t) => localYmd(t.dueDate as Date, "UTC") === addDaysYmd(today, 1)));
    assert.equal((await tap({ type: "undo_command" })).message.intent, "undone");
    const back = await prisma.task.findMany({ where: { userId: user.id } });
    assert.ok(back.every((t) => localYmd(t.dueDate as Date, "UTC") === today));
  });
});

test("bulk: complete by tag, delete completed (undo restores), no means nothing changes", { skip }, async () => {
  await withChatUser("FREE", async (say, tap, user) => {
    const mk = (title: string, extra: Record<string, unknown> = {}) => prisma.task.create({ data: { userId: user.id, title, priority: "MEDIUM", source: "CHAT", ...extra } });
    await mk("Physics lab", { tags: ["uni"] });
    await mk("Maths sheet", { tags: ["uni", "maths"] });
    await mk("Laundry");
    await say("complete all tasks tagged #uni");
    assert.equal((await say("no")).message.intent, "cancel");
    assert.equal(await prisma.task.count({ where: { userId: user.id, status: "COMPLETED" } }), 0);
    await say("mark all #uni tasks as done");
    assert.equal((await say("yes")).message.intent, "bulk_completed");
    assert.equal(await prisma.task.count({ where: { userId: user.id, status: "COMPLETED" } }), 2);

    assert.match((await say("delete all completed tasks")).message.content, /^Delete 2 completed tasks\?/);
    await say("yes");
    assert.equal(await prisma.task.count({ where: { userId: user.id, status: "DELETED" } }), 2);
    await say("undo");
    assert.equal(await prisma.task.count({ where: { userId: user.id, status: "DELETED" } }), 0);
  });
});

test("bulk: at most 25 tasks per confirmation; WhatsApp preview is short plain text with numbered options", { skip }, async () => {
  await withChatUser("FREE", async (say, _tap, user) => {
    for (let i = 1; i <= 30; i += 1) await prisma.task.create({ data: { userId: user.id, title: `Done ${i}`, priority: "LOW", source: "CHAT", status: "COMPLETED", completedAt: new Date(Date.now() - (40 - i) * 60000) } });
    const wa = await say("delete all completed tasks", "WHATSAPP");
    assert.match(wa.message.content, /^Delete 25 completed tasks\?/);
    assert.match(wa.message.content, /…and 17 more\nThat's the first 25 of 30/);
    assert.equal(wa.message.cards?.length ?? 0, 0);
    assert.deepEqual(wa.message.actions?.map((a) => a.label), ["Yes", "Cancel"]);
    await say("yes", "WHATSAPP");
    assert.equal(await prisma.task.count({ where: { userId: user.id, status: "DELETED" } }), 25);
  });
});
