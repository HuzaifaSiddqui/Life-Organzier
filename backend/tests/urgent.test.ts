import assert from "node:assert/strict";
import crypto, { randomUUID } from "node:crypto";
import test from "node:test";
import { Priority, TaskStatus, type UserSettings } from "@prisma/client";
import { prisma } from "../src/config/db.js";
import { planReminders } from "../src/modules/reminders/reminderService.js";
import { processInbound, resetInboundState } from "../src/modules/whatsapp/inbound.js";
import { MAX_SNOOZES_PER_TASK, parseSnooze, snoozeTask } from "../src/modules/whatsapp/snooze.js";
import { isUrgent, resetWhatsappPause, sendDueWhatsappReminders, sendUrgentWhatsappAlerts, URGENT_WITHIN_MS, type SendResult } from "../src/modules/whatsapp/whatsappService.js";
import { dbAvailable } from "./fixtures.js";

const skip = !dbAvailable && "no database";
const H = 3600000;

/* ------------------------------------------------------------------ pure */

test("urgent: pending HIGH/URGENT task due within the next 3 hours, nothing else", () => {
  const now = new Date("2026-10-05T05:00:00Z");
  const t = (o: Partial<{ status: TaskStatus; priority: Priority; dueAt: Date | null; archived: boolean }>) => ({ status: TaskStatus.PENDING, priority: Priority.HIGH, dueAt: new Date(now.getTime() + H), archived: false, ...o });
  const rows: Array<[string, ReturnType<typeof t>, boolean]> = [
    ["high, due in 1 h", t({}), true],
    ["urgent, due in 2 h 59 m", t({ priority: Priority.URGENT, dueAt: new Date(now.getTime() + URGENT_WITHIN_MS - 60000) }), true],
    ["exactly 3 h", t({ dueAt: new Date(now.getTime() + URGENT_WITHIN_MS) }), true],
    ["3 h + 1 min", t({ dueAt: new Date(now.getTime() + URGENT_WITHIN_MS + 60000) }), false],
    ["already overdue", t({ dueAt: new Date(now.getTime() - 60000) }), false],
    ["medium priority", t({ priority: Priority.MEDIUM }), false],
    ["low priority", t({ priority: Priority.LOW }), false],
    ["in progress", t({ status: TaskStatus.IN_PROGRESS }), false],
    ["completed", t({ status: TaskStatus.COMPLETED }), false],
    ["deleted", t({ status: TaskStatus.DELETED }), false],
    ["skipped", t({ status: TaskStatus.SKIPPED }), false],
    ["archived", t({ archived: true }), false],
    ["no due date", t({ dueAt: null }), false],
  ];
  for (const [name, task, expected] of rows) assert.equal(isUrgent(task, now), expected, name);
  assert.equal(URGENT_WITHIN_MS, 3 * H);
});

test("snooze: parsing (default 1 h, minutes and hours)", () => {
  const rows: Array<[string, number | null]> = [
    ["snooze", 60],
    ["Snooze 1h", 60],
    ["snooze 30m", 30],
    ["snooze 45 min", 45],
    ["snooze for 2 hours", 120],
    ["snooze 1.5h", 90],
    ["snooze 90", 90],
    ["snooze.", 60],
    ["snooze my alarm tomorrow", null],
    ["done", null],
  ];
  for (const [text, expected] of rows) assert.equal(parseSnooze(text), expected, text);
});

/* ------------------------------------------------------------------ database */


function fakeSender(result: SendResult = { ok: true, twilioCode: null }) {
  const sent: Array<{ to: string; body: string }> = [];
  return { sent, send: async (to: string, body: string) => (sent.push({ to, body }), result) };
}

const created: string[] = [];
const randomNumber = () => `+92300${crypto.randomInt(1000000, 9999999)}`;

function quiet(containsNow: boolean): { quietStart: string; quietEnd: string } {
  const h = new Date().getUTCHours();
  const hh = (x: number) => `${String((x + 24) % 24).padStart(2, "0")}:00`;
  return containsNow ? { quietStart: hh(h - 1), quietEnd: hh(h + 2) } : { quietStart: hh(h + 6), quietEnd: hh(h + 7) } // beyond the 4 h snooze maximum;
}

async function makeUser(opts: { lastMessageAgoMs?: number; quietNow?: boolean } = {}) {
  const number = randomNumber();
  const user = await prisma.user.create({
    data: {
      firebaseUid: `test-${randomUUID()}`,
      email: `ci-${randomUUID()}@example.test`,
      phoneNumber: number,
      phoneVerifiedAt: new Date(),
      settings: { create: { tier: "PRO", timezone: "UTC", ...quiet(Boolean(opts.quietNow)), lastWhatsappMessageAt: new Date(Date.now() - (opts.lastMessageAgoMs ?? 0)) } },
    },
    include: { settings: true },
  });
  created.push(user.id);
  return { user, number, settings: user.settings as UserSettings };
}

const urgentTask = (userId: string, dueInMs = 2 * H) => prisma.task.create({ data: { userId, title: `Submit report ${randomUUID().slice(0, 4)}`, priority: Priority.URGENT, dueAt: new Date(Date.now() + dueInMs) } });
const msg = (from: string, body: string) => ({ sid: `SMtest${randomUUID()}`, from: `whatsapp:${from}`, body, numMedia: 0, mediaType: "", mediaUrl: "" });
const settle = () => new Promise((r) => setTimeout(r, 60));

test.after(async () => {
  if (!dbAvailable) return;
  await prisma.user.deleteMany({ where: { id: { in: created } } });
  await prisma.whatsappInbound.deleteMany({ where: { messageSid: { startsWith: "SMtest" } } });
});

test("urgent: one WhatsApp alert per task, stored in the chat; '2' snoozes it", { skip }, async () => {
  resetWhatsappPause();
  resetInboundState();
  const { user, number } = await makeUser();
  const task = await urgentTask(user.id);
  const s = fakeSender();
  // Other test files run at the same time and the job serves every user: count only this user's messages.
  const mine = () => s.sent.filter((m) => m.to === number);
  await sendUrgentWhatsappAlerts(new Date(), s.send);
  await sendUrgentWhatsappAlerts(new Date(), s.send); // dedupe
  assert.equal(mine().length, 1);
  assert.match(mine()[0].body, /^Urgent: Submit report .+ is due .+\n\n1\. Done\n2\. Snooze 1h/);
  assert.equal(await prisma.reminderLog.count({ where: { taskId: task.id, level: "URGENT", status: "SENT_WHATSAPP" } }), 1);

  await processInbound(msg(number, "2"), s.send);
  const snooze = await prisma.reminderLog.findFirstOrThrow({ where: { taskId: task.id, level: "SNOOZE" } });
  assert.equal(snooze.status, "SNOOZED");
  assert.ok(Math.abs(snooze.fireAt.getTime() - (Date.now() + H)) < 60000);
  assert.match(s.sent.at(-1)?.body ?? "", /remind you about .+ again (?:today|tomorrow) at \d/);
});

test("urgent: outside the 24 h window → not sent, nothing claimed, logged once; a later in-window message still gets it", { skip }, async () => {
  resetWhatsappPause();
  const stale = await makeUser({ lastMessageAgoMs: 30 * H });
  const t1 = await urgentTask(stale.user.id);
  const s = fakeSender();
  await sendUrgentWhatsappAlerts(new Date(), s.send);
  await sendUrgentWhatsappAlerts(new Date(), s.send);
  assert.equal(s.sent.filter((m) => m.to === stale.number).length, 0);
  assert.equal(await prisma.reminderLog.count({ where: { taskId: t1.id } }), 0);
  assert.equal(await prisma.activityEvent.count({ where: { userId: stale.user.id, entityId: t1.id, type: "WHATSAPP_SKIPPED_WINDOW" } }), 1);
  // the user writes to the bot → window open → the next run sends the alert
  await prisma.userSettings.update({ where: { userId: stale.user.id }, data: { lastWhatsappMessageAt: new Date() } });
  await sendUrgentWhatsappAlerts(new Date(), s.send);
  assert.equal(s.sent.filter((m) => m.to === stale.number).length, 1);
  assert.equal(await prisma.reminderLog.count({ where: { taskId: t1.id, level: "URGENT", status: "SENT_WHATSAPP" } }), 1);

  const sleeping = await makeUser({ quietNow: true });
  const t2 = await urgentTask(sleeping.user.id);
  await sendUrgentWhatsappAlerts(new Date(), s.send);
  assert.equal(s.sent.filter((m) => m.to === sleeping.number).length, 0);
  assert.equal(await prisma.reminderLog.count({ where: { taskId: t2.id } }), 0); // tried again on a later run
});

test("snooze: clamped to 15 min–4 h, never past the due time, max 3, refused when already due", { skip }, async () => {
  const { user, settings } = await makeUser();
  const now = new Date();
  const far = await prisma.task.create({ data: { userId: user.id, title: "Far", dueAt: new Date(now.getTime() + 10 * H) } });
  const r1 = await snoozeTask(far, 5, settings, now);
  assert.ok(r1.ok && r1.minutes === 15);
  const r2 = await snoozeTask(far, 600, settings, now);
  assert.ok(r2.ok && r2.minutes === 240);
  const r3 = await snoozeTask(far, 60, settings, now);
  assert.ok(r3.ok);
  assert.deepEqual(await snoozeTask(far, 60, settings, now), { ok: false, reason: "limit" });
  assert.equal(await prisma.reminderLog.count({ where: { taskId: far.id, level: "SNOOZE" } }), MAX_SNOOZES_PER_TASK);

  const soon = await prisma.task.create({ data: { userId: user.id, title: "Soon", dueAt: new Date(now.getTime() + 20 * 60000) } });
  const r4 = await snoozeTask(soon, 60, settings, now);
  assert.ok(r4.ok && r4.atDueTime && r4.at.getTime() === soon.dueAt?.getTime());
  const gone = await prisma.task.create({ data: { userId: user.id, title: "Gone", dueAt: new Date(now.getTime() + 20000) } });
  assert.deepEqual(await snoozeTask(gone, 60, settings, now), { ok: false, reason: "due" });

});

test("snooze: inside quiet hours or DND it moves to when they end (said in the reply), unless that is past the due time", { skip }, async () => {
  resetInboundState();
  const now = new Date();
  const sleeping = await makeUser({ quietNow: true }); // quiet hours: from 1 h ago until the next full hour + 2
  const quietEnd = new Date(now);
  quietEnd.setUTCHours(now.getUTCHours() + 2, 0, 0, 0);
  const t = await prisma.task.create({ data: { userId: sleeping.user.id, title: "Night", dueAt: new Date(now.getTime() + 10 * H) } });
  const r = await snoozeTask(t, 15, sleeping.settings, now);
  assert.ok(r.ok && r.movedFor === "quiet" && r.at.getTime() === quietEnd.getTime(), JSON.stringify(r));
  const before = await prisma.task.create({ data: { userId: sleeping.user.id, title: "Before morning", dueAt: new Date(quietEnd.getTime() - 10 * 60000) } });
  assert.deepEqual(await snoozeTask(before, 15, sleeping.settings, now), { ok: false, reason: "muted" });

  const busy = await makeUser();
  const dndUntil = new Date(now.getTime() + 2 * H);
  const dndSettings = await prisma.userSettings.update({ where: { userId: busy.user.id }, data: { dndUntil, criticalOverridesDnd: false } });
  const t2 = await prisma.task.create({ data: { userId: busy.user.id, title: "Call back", dueAt: new Date(now.getTime() + 8 * H) } });
  const r2 = await snoozeTask(t2, 30, dndSettings, now);
  assert.ok(r2.ok && r2.movedFor === "dnd" && r2.at.getTime() === dndUntil.getTime(), JSON.stringify(r2));

  // the WhatsApp reply names the new time
  const reminded = await prisma.task.create({ data: { userId: sleeping.user.id, title: "Pack bag", dueAt: new Date(now.getTime() + 10 * H) } });
  const s = fakeSender();
  await prisma.conversation.deleteMany({ where: { userId: sleeping.user.id } });
  await processInbound(msg(sleeping.number, "snooze 30m"), s.send); // no reminder sent yet
  assert.equal(s.sent.at(-1)?.body, "Nothing to snooze right now.");
  const { addOutboundMessage } = await import("../src/modules/conversations/conversationService.js");
  await addOutboundMessage(sleeping.user.id, "WHATSAPP", "Reminder: Pack bag", { focusTaskId: reminded.id });
  await processInbound(msg(sleeping.number, "snooze 30m"), s.send);
  assert.match(s.sent.at(-1)?.body ?? "", /^Your quiet hours are on then, so I'll remind you about "Pack bag" /);
});

test("snooze: a re-plan keeps it, and it is sent when due", { skip }, async () => {
  resetWhatsappPause();
  const { user, number, settings } = await makeUser();
  const task = await prisma.task.create({ data: { userId: user.id, title: "Read chapter 4", dueAt: new Date(Date.now() + 6 * H), dueTime: "11:00 PM" } });
  const r = await snoozeTask(task, 60, settings);
  assert.ok(r.ok);
  await planReminders(user.id, settings, new Date());
  await planReminders(user.id, settings, new Date());
  assert.equal(await prisma.reminderLog.count({ where: { taskId: task.id, level: "SNOOZE", status: "SNOOZED" } }), 1);

  // due now → the WhatsApp job sends it like a reminder
  await prisma.reminderLog.updateMany({ where: { taskId: task.id, level: "SNOOZE" }, data: { fireAt: new Date(Date.now() - 60000) } });
  const s = fakeSender();
  await sendDueWhatsappReminders(new Date(), s.send);
  const mine = s.sent.filter((m) => m.to === number);
  assert.equal(mine.length, 1);
  assert.match(mine[0].body, /Read chapter 4/);
  assert.equal(await prisma.reminderLog.count({ where: { taskId: task.id, level: "SNOOZE", status: "SENT_WHATSAPP" } }), 1);
});

test("snooze: only a reminder from the last 6 hours can be snoozed; the reply names the task and the new time", { skip }, async () => {
  resetInboundState();
  const { user, number } = await makeUser();
  const old = await prisma.task.create({ data: { userId: user.id, title: "Old one", dueAt: new Date(Date.now() + 12 * H) } });
  const { addOutboundMessage } = await import("../src/modules/conversations/conversationService.js");
  await addOutboundMessage(user.id, "WHATSAPP", "Reminder: Old one", { focusTaskId: old.id });
  await prisma.conversationMessage.updateMany({ where: { userId: user.id, role: "ASSISTANT" }, data: { createdAt: new Date(Date.now() - 7 * H) } });
  const s = fakeSender();
  await processInbound(msg(number, "snooze"), s.send);
  assert.equal(s.sent.at(-1)?.body, "Nothing to snooze right now.");
  assert.equal(await prisma.reminderLog.count({ where: { taskId: old.id, level: "SNOOZE" } }), 0);

  const fresh = await prisma.task.create({ data: { userId: user.id, title: "Fresh one", dueAt: new Date(Date.now() + 12 * H) } });
  await addOutboundMessage(user.id, "WHATSAPP", "Reminder: Fresh one", { focusTaskId: fresh.id });
  await processInbound(msg(number, "snooze 2 hours"), s.send);
  assert.match(s.sent.at(-1)?.body ?? "", /^Okay, I'll remind you about "Fresh one" again (?:today|tomorrow) at \d{1,2}:\d{2} [AP]M\.$/);
  assert.equal(await prisma.reminderLog.count({ where: { taskId: fresh.id, level: "SNOOZE" } }), 1);
});
