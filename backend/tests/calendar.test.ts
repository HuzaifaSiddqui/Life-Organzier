import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { RoutineFrequency } from "@prisma/client";
import { AiService, setAi } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
// The engine first: command modules import it (a command module loaded first would see the registry half-built).
import { handleAssistantMessage, type Channel } from "../src/modules/assistant/dialogue.js";
import { parseCalendarAdd, parseCalendarAgenda, parseCalendarFree } from "../src/modules/assistant/commands/calendar.js";
import { activeCommands, classify, parseCtx } from "../src/modules/assistant/commands/registry.js";
import { calendarFeed } from "../src/modules/calendar/calendarService.js";
import { createRoutine } from "../src/modules/routines/routineService.js";
import { dbAvailable } from "./fixtures.js";

// CALENDAR_SYNC (default off). The phone's calendar never reaches the server: chat replies carry a card the phone fills in.
const skip = !dbAvailable && "no database";
const TZ = "Asia/Karachi";
const NOW = new Date("2026-11-04T05:00:00Z"); // Wednesday 10:00 in Karachi
const ctx = parseCtx({ now: NOW, tz: TZ });

function withFlag<T>(value: "on" | undefined, run: () => T): T {
  const keep = process.env.CALENDAR_SYNC;
  if (value) process.env.CALENDAR_SYNC = value;
  else delete process.env.CALENDAR_SYNC;
  const restore = () => {
    if (keep === undefined) delete process.env.CALENDAR_SYNC;
    else process.env.CALENDAR_SYNC = keep;
  };
  try {
    const out = run();
    if (out instanceof Promise) return out.finally(restore) as T;
    restore();
    return out;
  } catch (e) {
    restore();
    throw e;
  }
}

test("calendar rules: add / agenda / free, with the day from entities; ordinary messages don't match", () => {
  assert.deepEqual(parseCalendarAdd("Add this to my calendar"), { ref: "", text: "Add this" });
  assert.deepEqual(parseCalendarAdd("put the essay in my google calendar"), { ref: "essay", text: "put the essay" });
  assert.equal(parseCalendarAdd("Add dentist appointment on Friday 4 pm to my calendar")?.text, "Add dentist appointment on Friday 4 pm");
  assert.equal(parseCalendarAdd("add milk to the shopping list"), null);
  assert.deepEqual(parseCalendarAgenda("What's on my calendar tomorrow?", ctx), { date: "2026-11-05" });
  assert.deepEqual(parseCalendarAgenda("show my calendar for friday", ctx), { date: "2026-11-06" });
  assert.deepEqual(parseCalendarAgenda("my calendar", ctx), { date: "2026-11-04" });
  assert.equal(parseCalendarAgenda("calendar app is broken, remind me to fix it", ctx), null);
  assert.deepEqual(parseCalendarFree("When am I free tomorrow?", ctx), { date: "2026-11-05" });
  assert.deepEqual(parseCalendarFree("am i free on friday", ctx), { date: "2026-11-06" });
  assert.equal(parseCalendarFree("I'm free tomorrow so add gym at 5", ctx), null);
});

test("flag off changes nothing: calendar commands are hidden and the same messages classify as before", () => {
  const messages = ["Add this to my calendar", "What's on my calendar tomorrow?", "When am I free tomorrow?"];
  const off = withFlag(undefined, () => messages.map((m) => classify(m, ctx).command));
  assert.ok(off.every((c) => !c.startsWith("calendar_")), `off: ${off.join(", ")}`);
  assert.ok(withFlag(undefined, () => activeCommands().every((c) => !c.name.startsWith("calendar_"))));
  const on = withFlag("on", () => messages.map((m) => classify(m, ctx).command));
  assert.deepEqual(on, ["calendar_add", "calendar_agenda", "calendar_free"]);
});

test("feed: occurrences in the 14-day window from today, untimed ones all-day, every context included", { skip }, async () => {
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ, currentContext: "At Home" } });
  try {
    await createRoutine(user.id, TZ, { title: "Gym", frequency: RoutineFrequency.DAILY, dueTime: "7 PM", durationMinutes: 45 }, NOW);
    await createRoutine(user.id, TZ, { title: "Hostel breakfast", frequency: RoutineFrequency.DAILY, dueTime: "8 AM", locationContext: "At University" }, NOW);
    await createRoutine(user.id, TZ, { title: "Journal", frequency: RoutineFrequency.DAILY, noReminder: true }, NOW);
    const feed = await calendarFeed(user.id, TZ, NOW);
    assert.equal(feed.windowStart, "2026-11-03T19:00:00.000Z");
    assert.equal(feed.windowEnd, "2026-11-17T19:00:00.000Z");
    const gym = feed.occurrences.filter((o) => o.title === "Gym");
    assert.equal(gym.length, 14);
    assert.equal(gym[0].start, "2026-11-04T14:00:00.000Z");
    assert.equal(gym[0].end, "2026-11-04T14:45:00.000Z");
    assert.ok(feed.occurrences.some((o) => o.title === "Hostel breakfast"), "other contexts are in the calendar too");
    assert.ok(feed.occurrences.every((o) => Date.parse(o.start) >= Date.parse(feed.windowStart) && Date.parse(o.start) < Date.parse(feed.windowEnd)));
    const journal = feed.occurrences.find((o) => o.title === "Journal");
    if (journal) assert.equal(journal.allDay, true);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test("chat (flag on): agenda and free replies carry a card and no calendar data; add resolves 'this'; WhatsApp points to the app", { skip }, async () => {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ } });
  const say = async (text: string, channel: Channel = "APP") =>
    handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, text, channel, now: NOW });
  try {
    await withFlag("on", async () => {
      const agenda = await say("What's on my calendar tomorrow?");
      assert.deepEqual(agenda.message.cards, [{ type: "calendar", kind: "agenda", date: "2026-11-05" }]);
      const free = await say("when am i free tomorrow");
      assert.deepEqual(free.message.cards, [{ type: "calendar", kind: "free", date: "2026-11-05" }]);

      const created = await say("Submit physics report on Friday at 3 PM");
      assert.equal(created.message.intent, "task_created");
      const added = await say("add this to my calendar");
      const card = added.message.cards?.[0] as { type: string; kind: string; taskId?: string; title?: string };
      assert.equal(card.type, "calendar");
      assert.equal(card.kind, "add");
      const task = await prisma.task.findFirstOrThrow({ where: { userId: user.id } });
      assert.equal(card.taskId, task.id);

      // Nothing by that name: it's a new task (which then goes to the calendar like any other).
      const fresh = await say("Add dentist appointment on Friday at 4 PM to my calendar");
      assert.equal(fresh.message.intent, "task_created");
      assert.ok(await prisma.task.findFirst({ where: { userId: user.id, title: { contains: "entist" } } }));

      const wa = await say("What's on my calendar tomorrow?", "WHATSAPP_AGENT");
      assert.equal(wa.message.intent, "calendar_phone_only");
      assert.equal(wa.message.cards?.length ?? 0, 0);
    });
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});
