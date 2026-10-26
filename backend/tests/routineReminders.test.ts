import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { User, UserSettings } from "@prisma/client";
import { AiService, setAi } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import { backgroundSettled } from "../src/lib/background.js";
import { addDaysYmd, formatClock, localYmd, zonedTimeToUtc } from "../src/lib/time.js";
// The registry first, as in the app: it loads every command module in order.
import "../src/modules/assistant/commands/registry.js";
import { handleAssistantMessage } from "../src/modules/assistant/dialogue.js";
import { registerPushToken, resetPushState, setPushProvider, type PushMessage } from "../src/modules/push/pushService.js";
import { capReminders, planReminders, ROUTINE_REMINDER_SHARE, routineReminderTimes, type PlannedReminder } from "../src/modules/reminders/reminderService.js";
import { createRoutine, defaultRoutineHour, updateRoutine } from "../src/modules/routines/routineService.js";
import { dbAvailable } from "./fixtures.js";

const skip = !dbAvailable && "no database";
const TZ = "Asia/Karachi";
/** Pinned clock: Monday 5 March 2040, 7:00 AM in Karachi. Never the real clock. */
const NOW = new Date("2040-03-05T02:00:00Z");
const TODAY = "2040-03-05";
const at = (ymd: string, h: number, m = 0) => zonedTimeToUtc(ymd, h, m, TZ);
const clock = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
const SETTINGS = { quietStart: "22:00", quietEnd: "08:00", criticalOverridesDnd: false, notificationFrequency: "NORMAL" } as UserSettings;
const kinds = (list: Array<{ kind: string; at: Date }>) => list.map((r) => `${r.kind}@${clock(r.at)}`);

/* ------------------------------------------------------------------ rules (no database) */

test("a pending occurrence today: start nudge 10 min before, the alarm at the time, one follow-up 20 min after", () => {
  assert.deepEqual(kinds(routineReminderTimes(at(TODAY, 9), "NORMAL", SETTINGS, TZ, null, NOW)), ["start@08:50", "time@09:00", "follow1@09:20"]);
});

test("a mandatory routine gets a second follow-up at +60 minutes", () => {
  assert.deepEqual(kinds(routineReminderTimes(at(TODAY, 9), "MANDATORY", SETTINGS, TZ, null, NOW)), ["start@08:50", "time@09:00", "follow1@09:20", "follow2@10:00"]);
});

test("follow-ups only within 36 hours; later days keep the start nudge and the alarm", () => {
  assert.deepEqual(kinds(routineReminderTimes(at(addDaysYmd(TODAY, 1), 9), "MANDATORY", SETTINGS, TZ, null, NOW)), ["start@08:50", "time@09:00", "follow1@09:20", "follow2@10:00"]);
  assert.deepEqual(kinds(routineReminderTimes(at(addDaysYmd(TODAY, 2), 9), "MANDATORY", SETTINGS, TZ, null, NOW)), ["start@08:50", "time@09:00"]);
});

test("quiet hours (22:00–08:00): the alarm still fires; the nudge and follow-ups don't, except mandatory with criticalOverridesDnd", () => {
  const early = at(addDaysYmd(TODAY, 1), 7, 30);
  assert.deepEqual(kinds(routineReminderTimes(early, "NORMAL", SETTINGS, TZ, null, NOW)), ["time@07:30"]);
  const late = at(TODAY, 21, 50);
  assert.deepEqual(kinds(routineReminderTimes(late, "MANDATORY", SETTINGS, TZ, null, NOW)), ["start@21:40", "time@21:50"]);
  assert.deepEqual(kinds(routineReminderTimes(late, "MANDATORY", { ...SETTINGS, criticalOverridesDnd: true }, TZ, null, NOW)), ["start@21:40", "time@21:50", "follow1@22:10", "follow2@22:50"]);
});

test("Do Not Disturb: nothing for a normal routine; with criticalOverridesDnd the alarm, and mandatory follow-ups", () => {
  const dnd = at(TODAY, 11);
  assert.deepEqual(kinds(routineReminderTimes(at(TODAY, 9), "NORMAL", SETTINGS, TZ, dnd, NOW)), []);
  assert.deepEqual(kinds(routineReminderTimes(at(TODAY, 9), "NORMAL", { ...SETTINGS, criticalOverridesDnd: true }, TZ, dnd, NOW)), ["time@09:00"]);
  assert.deepEqual(kinds(routineReminderTimes(at(TODAY, 9), "MANDATORY", { ...SETTINGS, criticalOverridesDnd: true }, TZ, dnd, NOW)), ["start@08:50", "time@09:00", "follow1@09:20", "follow2@10:00"]);
});

test("minimal reminders: a normal routine gets only the alarm; nothing is planned in the past", () => {
  assert.deepEqual(kinds(routineReminderTimes(at(TODAY, 9), "NORMAL", { ...SETTINGS, notificationFrequency: "MINIMAL" }, TZ, null, NOW)), ["time@09:00"]);
  const tenAm = at(TODAY, 10);
  assert.deepEqual(kinds(routineReminderTimes(at(TODAY, 9, 50), "NORMAL", SETTINGS, TZ, null, tenAm)), ["follow1@10:10"], "started 10 minutes ago: only the follow-up is still ahead");
});

test("the cap: routine reminders never push task reminders out beyond their share", () => {
  const mk = (prefix: string, n: number): PlannedReminder[] =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, taskId: prefix === "t" ? `t${i}` : null, routineOccurrenceId: prefix === "r" ? `o${i}` : null, fireAt: new Date(NOW.getTime() + (i + 1) * 60000).toISOString(), level: "normal", title: "", body: "", prominent: false }));
  const count = (list: PlannedReminder[], p: string) => list.filter((r) => r.id.startsWith(p)).length;
  const both = capReminders(mk("t", 50), mk("r", 40)); // routines are all sooner here
  assert.deepEqual([both.length, count(both, "t"), count(both, "r")], [60, 60 - ROUTINE_REMINDER_SHARE, ROUTINE_REMINDER_SHARE]);
  const fewTasks = capReminders(mk("t", 10), mk("r", 70));
  assert.deepEqual([count(fewTasks, "t"), count(fewTasks, "r")], [10, 50], "unused task room goes to routines");
  const fewRoutines = capReminders(mk("t", 70), mk("r", 5));
  assert.deepEqual([count(fewRoutines, "t"), count(fewRoutines, "r")], [55, 5]);
});

test("default time: the peak start hour (9 when unknown), moved out of quiet hours", () => {
  assert.equal(defaultRoutineHour(null, "22:00", "08:00"), 9);
  assert.equal(defaultRoutineHour(14, "22:00", "08:00"), 14);
  assert.equal(defaultRoutineHour(6, "22:00", "08:00"), 8, "6 AM is inside quiet hours: quiet end");
  assert.equal(defaultRoutineHour(23, "22:00", "07:30"), 8, "rounded up to the hour");
});

/* ------------------------------------------------------------------ chat, WhatsApp and the plan (database) */

async function withUser(fn: (say: (text: string, channel?: "APP" | "WHATSAPP") => ReturnType<typeof handleAssistantMessage>, user: User) => Promise<void>) {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ, tier: "PRO" } });
  try {
    const say = async (text: string, channel: "APP" | "WHATSAPP" = "APP") =>
      handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, text, channel, now: NOW });
    await fn(say, user);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
}
const plan = async (user: User) => planReminders(user.id, await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), NOW);
const forRoutine = (list: PlannedReminder[], title: string) =>
  list.filter((r) => r.title === title || r.title === `Still to do: ${title}`).map((r) => `${localYmd(new Date(r.fireAt), TZ)} ${clock(new Date(r.fireAt))} ${r.id.split(":").pop()}`);

test("the medicine sentence: no time given → 9 AM, the reply says so, and the reminders follow the interval", { skip }, async () => {
  await withUser(async (say, user) => {
    const r = await say("I take medicine on every alternative day, I have already taken medicine of today");
    assert.match(r.message.content, /No time given, so I'll remind you at 9 AM\./);
    const routine = await prisma.routine.findFirstOrThrow({ where: { userId: user.id } });
    assert.equal(routine.dueTime, "9 AM");
    // Today's is done (none today); the next is in 2 days (beyond 36 h: nudge + alarm), then every 2 days.
    assert.deepEqual(forRoutine(await plan(user), routine.title), [
      `${addDaysYmd(TODAY, 2)} 08:50 start`,
      `${addDaysYmd(TODAY, 2)} 09:00 time`,
      `${addDaysYmd(TODAY, 4)} 08:50 start`,
      `${addDaysYmd(TODAY, 4)} 09:00 time`,
      `${addDaysYmd(TODAY, 6)} 08:50 start`,
      `${addDaysYmd(TODAY, 6)} 09:00 time`,
    ]);
  });
});

test("a time-of-day word sets the time (English and Roman Urdu); an explicit time wins", { skip }, async () => {
  await withUser(async (say, user) => {
    await say("read every day in the evening");
    await say("walk karna har roz shaam ko");
    await say("stretch every day at 7:15 am");
    const times = (await prisma.routine.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } })).map((r) => r.dueTime);
    assert.deepEqual(times, ["6 PM", "6 PM", "7:15 AM"]);
  });
});

test("the time question after a default: ignored keeps the default; a time changes it; 'no reminder' clears it", { skip }, async () => {
  await withUser(async (say, user) => {
    await say("water the plants every 3 days");
    await say("hey how are you");
    await say("evening");
    assert.equal((await prisma.routine.findFirstOrThrow({ where: { userId: user.id } })).dueTime, "9 AM", "ignored: the default stays");

    await say("read a chapter every other day");
    assert.equal((await say("9:30 pm")).message.intent, "routine_time_set");
    assert.equal((await prisma.routine.findFirstOrThrow({ where: { userId: user.id, title: { contains: "chapter", mode: "insensitive" } } })).dueTime, "9:30 PM");

    await say("journal every day");
    const off = await say("no reminder");
    assert.match(off.message.content, /no reminder for/i);
    const journal = await prisma.routine.findFirstOrThrow({ where: { userId: user.id, title: { contains: "journal", mode: "insensitive" } } });
    assert.equal(journal.dueTime, null);
    assert.deepEqual(forRoutine(await plan(user), journal.title), [], "no reminder: nothing planned");
  });
});

test("'no reminder' in the sentence: created without a time; the form, documents and other callers get the default", { skip }, async () => {
  await withUser(async (say, user) => {
    await say("meditate every day, no reminder");
    const m = await prisma.routine.findFirstOrThrow({ where: { userId: user.id } });
    assert.equal(m.dueTime, null);
    assert.doesNotMatch(m.title, /reminder/i);
    const form = await createRoutine(user.id, TZ, { title: "Form routine", frequency: "DAILY" }, NOW);
    assert.equal(form.dueTime, "9 AM", "the routine form and document-created routines share createRoutine");
    const none = await createRoutine(user.id, TZ, { title: "Quiet routine", frequency: "DAILY", noReminder: true }, NOW);
    assert.equal(none.dueTime, null);
    // The form: switching the reminder off clears the time; back on with no time gives the default again.
    assert.equal((await updateRoutine(user.id, TZ, form.id, { noReminder: true }, NOW))?.dueTime, null);
    assert.equal((await updateRoutine(user.id, TZ, form.id, { noReminder: false, dueTime: null }, NOW))?.dueTime, "9 AM");
    assert.equal((await updateRoutine(user.id, TZ, form.id, { noReminder: false, dueTime: "7 PM" }, NOW))?.dueTime, "7 PM");
  });
});

test("a mandatory routine today: both follow-ups planned; done in chat → none of its reminders are planned", { skip }, async () => {
  await withUser(async (say, user) => {
    await createRoutine(user.id, TZ, { title: "Gym", frequency: "DAILY", dueTime: "9 AM", priority: "MANDATORY" }, NOW);
    assert.deepEqual(forRoutine(await plan(user), "Gym").filter((s) => s.startsWith(TODAY)), [`${TODAY} 08:50 start`, `${TODAY} 09:00 time`, `${TODAY} 09:20 follow1`, `${TODAY} 10:00 follow2`]);
    assert.equal((await say("I did my gym routine today")).message.intent, "routine_done");
    assert.deepEqual(forRoutine(await plan(user), "Gym").filter((s) => s.startsWith(TODAY)), [], "completed: no follow-ups (the app re-plans after every chat reply)");
    assert.ok(forRoutine(await plan(user), "Gym").some((s) => s.startsWith(addDaysYmd(TODAY, 1))), "tomorrow's are still planned");
  });
});

test("WhatsApp: done or skipped there → nothing planned for it, and a sync push tells the phone to drop its alarms", { skip }, async () => {
  resetPushState();
  const sent: PushMessage[] = [];
  setPushProvider({ send: async (msgs) => (sent.push(...msgs), msgs.map(() => ({ id: `ticket-${randomUUID()}` }))), receipts: async () => ({}) });
  await withUser(async (say, user) => {
    await registerPushToken(user.id, { token: `ExponentPushToken[${randomUUID()}]`, platform: "android" });
    await createRoutine(user.id, TZ, { title: "Reading", frequency: "DAILY", dueTime: "9 AM" }, NOW);
    await createRoutine(user.id, TZ, { title: "Walk", frequency: "DAILY", dueTime: "6 PM" }, NOW);
    assert.equal((await say("I did my reading routine today", "WHATSAPP")).message.intent, "routine_done");
    assert.equal((await say("skip walk today", "WHATSAPP")).message.intent, "routine_skipped");
    await backgroundSettled();
    assert.deepEqual(sent.map((m) => [m.title, m.body, m.data]), [
      ["Updated from WhatsApp", "Reading: done for today", { type: "sync" }],
      ["Updated from WhatsApp", "Walk: skipped for today", { type: "sync" }],
    ]);
    const list = await plan(user);
    assert.deepEqual([...forRoutine(list, "Reading"), ...forRoutine(list, "Walk")].filter((s) => s.startsWith(TODAY)), []);
  });
});

test("many tasks and many routines: tasks keep their reminders (routines get 24 of 60, tasks the rest)", { skip }, async () => {
  await withUser(async (_say, user) => {
    // 40 tasks due over the next 5 days at 5 PM (each has several reminders) and 15 daily routines.
    for (let i = 0; i < 40; i += 1) {
      const ymd = addDaysYmd(TODAY, 1 + (i % 5));
      await prisma.task.create({ data: { userId: user.id, title: `Task ${i}`, priority: "MEDIUM", source: "CHAT", dueTime: "5 PM", dueAt: at(ymd, 17), dueDate: at(ymd, 0) } });
    }
    for (let i = 0; i < 15; i += 1) await createRoutine(user.id, TZ, { title: `Routine ${i}`, frequency: "DAILY", dueTime: formatClock(8 + (i % 12), i % 2 ? 30 : 0) }, NOW);
    const planned = await plan(user);
    const tasks = planned.filter((r) => r.taskId).length;
    const routines = planned.filter((r) => r.routineOccurrenceId).length;
    assert.equal(planned.length, 60);
    assert.equal(routines, ROUTINE_REMINDER_SHARE, "routines are held to their share");
    assert.equal(tasks, 60 - ROUTINE_REMINDER_SHARE, "tasks keep the rest");
    assert.ok(planned.some((r) => r.taskId && new Date(r.fireAt).getTime() - NOW.getTime() < 36 * 3600000), "the soonest task reminders are kept");
  });
});
