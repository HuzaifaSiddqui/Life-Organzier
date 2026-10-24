import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { User } from "@prisma/client";
import { AiService, setAi } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import { handleAssistantMessage, USE_ROUTINE_SCREEN } from "../src/modules/assistant/dialogue.js";
import { extractInterval } from "../src/modules/assistant/entities.js";
import { analyzeDocument, INTERVAL_WARNING } from "../src/modules/documents/documentProcessing.js";
import { addDaysYmd, localYmd, startOfLocalDay } from "../src/lib/time.js";
import { createRoutine, generateRoutineOccurrences, intervalMatches, markTodayDone, occurrencesForDay, routineMatchesDay, updateRoutine } from "../src/modules/routines/routineService.js";
import { dbAvailable } from "./fixtures.js";

const skip = !dbAvailable && "no database";
const TZ = "Asia/Karachi";
/** The reported sentence. */
const MEDICINE = "I take medicine on every alternative day, I have already taken medicine of today";

async function withUser(fn: (say: (text: string) => ReturnType<typeof handleAssistantMessage>, user: User) => Promise<void>, timezone = TZ) {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone } });
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

test("documents: pasted text with an interval phrase says why nothing was made", async () => {
  const a = await analyzeDocument({ text: MEDICINE, fileName: "Pasted text", mimeType: "text/plain", docType: "SCHEDULE", language: "eng", tz: TZ });
  assert.equal(a.warning, INTERVAL_WARNING);
  assert.deepEqual([a.schedules.length, a.deadlines.length], [0, 0]);
});

/** One table for the day rule: anchor, every N days, day, counts? (calendar dates; month and year ends, leap day). */
const DAY_RULE_CASES: Array<[string, number, string, boolean]> = [
  ["2026-10-25", 2, "2026-10-25", true],
  ["2026-10-25", 2, "2026-10-26", false],
  ["2026-10-25", 2, "2026-10-27", true],
  ["2026-10-25", 2, "2026-10-24", false], // before the start
  ["2026-10-30", 2, "2026-11-01", true], // October has 31 days
  ["2026-10-30", 2, "2026-10-31", false],
  ["2026-12-30", 3, "2027-01-02", true], // year end
  ["2028-02-27", 2, "2028-02-29", true], // leap day
  ["2028-02-27", 2, "2028-03-01", false],
  ["2026-10-25", 7, "2026-11-01", true],
];

test("day rule: distance from the start date is a multiple of N (one table)", () => {
  for (const [anchor, n, ymd, want] of DAY_RULE_CASES) {
    assert.equal(intervalMatches(anchor, n, ymd), want, `${anchor} every ${n}: ${ymd}`);
    assert.equal(routineMatchesDay({ frequency: "DAILY", daysOfWeek: null, dayOfMonth: null, intervalDays: n, anchorDate: anchor }, ymd), want);
  }
  assert.equal(routineMatchesDay({ frequency: "WEEKLY", daysOfWeek: [1], dayOfMonth: null, intervalDays: null, anchorDate: null }, "2026-10-26"), true, "no interval: weekdays as before");
});

test("local days survive DST: each day's start maps back to the same date (London 25 Oct, New York 1 Nov 2026)", () => {
  for (const timezone of ["Europe/London", "America/New_York", TZ]) {
    for (let d = 0; d <= 11; d += 1) {
      const ymd = addDaysYmd("2026-10-23", d);
      assert.equal(localYmd(startOfLocalDay(ymd, timezone), timezone), ymd, `${timezone} ${ymd}`);
    }
  }
  // Every other day from 24 Oct, as each zone's own dates: 24, 26, 28, 30 Oct, 1 Nov, 3 Nov.
  const days = Array.from({ length: 12 }, (_, d) => addDaysYmd("2026-10-23", d)).filter((ymd) => intervalMatches("2026-10-24", 2, ymd));
  assert.deepEqual(days, ["2026-10-24", "2026-10-26", "2026-10-28", "2026-10-30", "2026-11-01", "2026-11-03"]);
});

for (const timezone of ["Europe/London", "America/New_York"]) {
  test(`occurrences are on the user's local dates (${timezone})`, { skip }, async () => {
    await withUser(async (_say, user) => {
      const today = localYmd(new Date(), timezone);
      const r = await createRoutine(user.id, timezone, { title: "Plants", frequency: "DAILY", intervalDays: 2, anchorDate: today });
      const rows = await prisma.routineOccurrence.findMany({ where: { routineId: r.id }, orderBy: { occurrenceDate: "asc" } });
      const days = rows.map((o) => localYmd(o.occurrenceDate, timezone));
      assert.deepEqual(days.slice(0, 4), [0, 2, 4, 6].map((d) => addDaysYmd(today, d)));
    }, timezone);
  });
}

test("the reported sentence: one routine every 2 days from today, today done; the day after tomorrow shows it, tomorrow not", { skip }, async () => {
  await withUser(async (say, user) => {
    const r = await say(MEDICINE);
    assert.equal(r.message.intent, "routine_created");
    const routines = await prisma.routine.findMany({ where: { userId: user.id } });
    assert.equal(routines.length, 1);
    const [routine] = routines;
    const today = localYmd(new Date(), TZ);
    assert.deepEqual([routine.title, routine.intervalDays, routine.anchorDate], ["Take medicine", 2, today]);
    const on = async (d: number) => (await occurrencesForDay(user.id, TZ, addDaysYmd(today, d))).filter((o) => o.routineId === routine.id);
    assert.deepEqual((await on(0)).map((o) => o.status), ["COMPLETED"]);
    assert.equal((await on(1)).length, 0, "tomorrow: not due");
    assert.deepEqual((await on(2)).map((o) => o.status), ["PENDING"], "day after tomorrow: due");
    assert.equal(await prisma.task.count({ where: { userId: user.id } }), 0, "no stray one-off task");
  });
});

test("marking today done twice keeps one occurrence", { skip }, async () => {
  await withUser(async (_say, user) => {
    const r = await createRoutine(user.id, TZ, { title: "Medicine", frequency: "DAILY", intervalDays: 2, anchorDate: localYmd(new Date(), TZ) });
    await markTodayDone(user.id, TZ, r.id);
    await markTodayDone(user.id, TZ, r.id);
    await generateRoutineOccurrences(user.id, TZ);
    const today = (await occurrencesForDay(user.id, TZ, localYmd(new Date(), TZ))).filter((o) => o.routineId === r.id);
    assert.deepEqual(today.map((o) => o.status), ["COMPLETED"]);
  });
});

test("changing the interval removes only future pending occurrences; completed ones stay", { skip }, async () => {
  await withUser(async (_say, user) => {
    const today = localYmd(new Date(), TZ);
    const r = await createRoutine(user.id, TZ, { title: "Medicine", frequency: "DAILY", intervalDays: 2, anchorDate: today });
    await markTodayDone(user.id, TZ, r.id);
    await updateRoutine(user.id, TZ, r.id, { intervalDays: 3, anchorDate: today });
    const rows = await prisma.routineOccurrence.findMany({ where: { routineId: r.id }, orderBy: { occurrenceDate: "asc" } });
    const shown = rows.map((o) => `${localYmd(o.occurrenceDate, TZ)}:${o.status}`);
    assert.equal(shown[0], `${today}:COMPLETED`, "today's done one is kept");
    assert.deepEqual(shown.slice(1, 3), [`${addDaysYmd(today, 3)}:PENDING`, `${addDaysYmd(today, 6)}:PENDING`], "every 3 days now");
    assert.ok(!shown.includes(`${addDaysYmd(today, 2)}:PENDING`), "the old every-2-days ones are gone");
  });
});

test("routine API rules: interval 2..30 with a start date; new weekdays drop the interval", { skip }, async () => {
  await withUser(async (_say, user) => {
    const today = localYmd(new Date(), TZ);
    await assert.rejects(createRoutine(user.id, TZ, { title: "X", frequency: "DAILY", intervalDays: 2 }), /start date/);
    await assert.rejects(createRoutine(user.id, TZ, { title: "X", frequency: "DAILY", intervalDays: 1, anchorDate: today }), /2 to 30/);
    await assert.rejects(createRoutine(user.id, TZ, { title: "X", frequency: "DAILY", intervalDays: 31, anchorDate: today }), /2 to 30/);
    const r = await createRoutine(user.id, TZ, { title: "Gym", frequency: "DAILY", intervalDays: 2, anchorDate: today });
    const weekly = await updateRoutine(user.id, TZ, r.id, { frequency: "WEEKLY", daysOfWeek: [1, 3] });
    assert.deepEqual([weekly?.intervalDays, weekly?.anchorDate], [null, null]);
  });
});

test("chat: changing an existing routine's interval points to the routine screen; nothing changes", { skip }, async () => {
  await withUser(async (say, user) => {
    const r = await createRoutine(user.id, TZ, { title: "Gym", frequency: "WEEKLY", daysOfWeek: [1, 3, 5], dueTime: "7 PM" });
    for (const text of ["change my gym routine to every other day", "make it every 3 days", "switch gym to har doosre din"]) {
      const out = await say(text);
      assert.equal(out.message.content, USE_ROUTINE_SCREEN, text);
    }
    const after = await prisma.routine.findUniqueOrThrow({ where: { id: r.id } });
    assert.deepEqual([after.intervalDays, after.daysOfWeek], [null, [1, 3, 5]]);
  });
});

test("chat: Roman Urdu and a time; English replies", { skip }, async () => {
  await withUser(async (say, user) => {
    assert.match((await say("har doosre din paudon ko pani dena")).message.content, /^Created: Every other day/);
    assert.match((await say("Gym every 3 days at 7 PM")).message.content, /^Created: Every 3 days Gym \(7 PM\)/);
    assert.deepEqual((await prisma.routine.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } })).map((r) => r.intervalDays), [2, 3]);
  });
});
