import assert from "node:assert/strict";
import crypto, { randomUUID } from "node:crypto";
import test from "node:test";
import { Priority, TaskStatus } from "@prisma/client";
import { prisma } from "../src/config/db.js";
import { CRISIS_RESOURCES } from "../src/modules/mood/crisis.js";
import { MISSED_REPLY, PRO_ONLY_REPLY, processInbound, recordInbound, recoverStuckInbound, resetInboundState, twilioSignatureValid, UNLINKED_REPLY } from "../src/modules/whatsapp/inbound.js";
import { CODE_ALPHABET, generateCode, LINK_FAILED_REPLY, LINKED_REPLY, maskNumber, normalizeNumber, parseLinkCommand, resetLinkFailures, startLink } from "../src/modules/whatsapp/linking.js";
import { resetWhatsappPause, sendDueWhatsappReminders, splitMessage, TWILIO_WINDOW_CLOSED, type SendResult } from "../src/modules/whatsapp/whatsappService.js";
import { dbAvailable } from "./fixtures.js";

const skip = !dbAvailable && "no database";

/* ------------------------------------------------------------------ pure */

test("whatsapp: Twilio signature over URL + sorted params; tampering fails", () => {
  const url = "https://api.example.test/api/whatsapp/webhook";
  const params = { MessageSid: "SM1", From: "whatsapp:+923001234567", Body: "hi" };
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k as keyof typeof params], url);
  const sig = crypto.createHmac("sha1", "secret").update(data).digest("base64");
  assert.equal(twilioSignatureValid(url, params, sig, "secret"), true);
  assert.equal(twilioSignatureValid(url, { ...params, Body: "hi!" }, sig, "secret"), false);
  assert.equal(twilioSignatureValid(url, params, sig, "other-token"), false);
  assert.equal(twilioSignatureValid(url, params, undefined, "secret"), false);
  assert.equal(twilioSignatureValid(url, params, "short", "secret"), false);
});

test("whatsapp: link codes are 8 chars from an alphabet without 0/O/1/I; LINK parsing; numbers", () => {
  for (let i = 0; i < 50; i += 1) {
    const c = generateCode();
    assert.equal(c.length, 8);
    assert.ok([...c].every((ch) => CODE_ALPHABET.includes(ch)));
  }
  assert.ok(!/[01OI]/.test(CODE_ALPHABET));
  assert.equal(parseLinkCommand("LINK 7KQ9MX2P"), "7KQ9MX2P");
  assert.equal(parseLinkCommand("  link 7kq9-mx2p "), "7KQ9MX2P");
  assert.equal(parseLinkCommand("link 123"), null);
  assert.equal(parseLinkCommand("link 1234567890"), ""); // a LINK attempt, but the wrong length: counts as a failure
  assert.equal(parseLinkCommand("linking my tasks"), null);
  assert.equal(normalizeNumber("whatsapp:+92 300-1234567"), "+923001234567");
  assert.equal(normalizeNumber("03001234567"), null);
  assert.equal(maskNumber("+923001234567"), "••••••567");
});

test("whatsapp: long replies are split under 1500 chars on word boundaries", () => {
  const body = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
  const parts = splitMessage(body);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 1500));
  assert.equal(parts.join(" "), body);
  assert.deepEqual(splitMessage("short"), ["short"]);
});

/* ------------------------------------------------------------------ database */

type Sent = { to: string; body: string };
function fakeSender(result: SendResult = { ok: true, twilioCode: null }) {
  const sent: Sent[] = [];
  return {
    sent,
    send: async (to: string, body: string) => {
      sent.push({ to, body });
      return result;
    },
  };
}

const randomNumber = () => `+92300${crypto.randomInt(1000000, 9999999)}`;
const created: string[] = [];

async function makeUser(opts: { tier?: "PRO" | "FREE"; linkedNumber?: string | null; quietStart?: string; quietEnd?: string } = {}) {
  const user = await prisma.user.create({
    data: {
      firebaseUid: `test-${randomUUID()}`,
      email: `ci-${randomUUID()}@example.test`,
      phoneNumber: opts.linkedNumber ?? null,
      phoneVerifiedAt: opts.linkedNumber ? new Date() : null,
      settings: { create: { tier: opts.tier ?? "PRO", timezone: "UTC", quietStart: opts.quietStart ?? "22:00", quietEnd: opts.quietEnd ?? "08:00", lastWhatsappMessageAt: new Date() } },
    },
  });
  created.push(user.id);
  return user;
}

const msg = (from: string, body: string) => ({ sid: `SMtest${randomUUID()}`, from: `whatsapp:${from}`, body, numMedia: 0, mediaType: "", mediaUrl: "" });

/** A quiet-hours window (UTC) that does or doesn't contain the current time. */
function quiet(containsNow: boolean): { quietStart: string; quietEnd: string } {
  const h = new Date().getUTCHours();
  const hh = (x: number) => `${String((x + 24) % 24).padStart(2, "0")}:00`;
  return containsNow ? { quietStart: hh(h - 1), quietEnd: hh(h + 2) } : { quietStart: hh(h + 3), quietEnd: hh(h + 4) };
}

test.after(async () => {
  if (!dbAvailable) return;
  await prisma.user.deleteMany({ where: { id: { in: created } } });
  await prisma.whatsappInbound.deleteMany({ where: { messageSid: { startsWith: "SMtest" } } });
});

test("whatsapp: a MessageSid is processed once; Twilio retries are ignored", { skip }, async () => {
  const sid = `SMtest${randomUUID()}`;
  assert.equal(await recordInbound(sid, "whatsapp:+923001112223"), true);
  assert.equal(await recordInbound(sid, "whatsapp:+923001112223"), false);
});

test("whatsapp link: success, wrong code, expired code — one generic failure reply", { skip }, async () => {
  resetLinkFailures();
  const user = await makeUser();
  const number = randomNumber();
  const f = fakeSender();
  await processInbound(msg(number, "LINK AAAAAAAA"), f.send); // wrong
  const { code } = await startLink(user.id, new Date(Date.now() - 11 * 60000)); // already expired
  await processInbound(msg(number, `LINK ${code}`), f.send);
  assert.deepEqual(f.sent.map((s) => s.body), [LINK_FAILED_REPLY, LINK_FAILED_REPLY]);

  const fresh = await startLink(user.id);
  await processInbound(msg(number, `link ${fresh.code.slice(0, 4)}-${fresh.code.slice(4)}`), f.send);
  assert.equal(f.sent.at(-1)?.body, LINKED_REPLY);
  const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(after.phoneNumber, number);
  assert.ok(after.phoneVerifiedAt);
  assert.equal(await prisma.whatsappLinkCode.count({ where: { userId: user.id } }), 0); // code is single-use
});

test("whatsapp link: brute force from one number is locked out for the hour, silently", { skip }, async () => {
  resetLinkFailures();
  const user = await makeUser();
  const attacker = randomNumber();
  const f = fakeSender();
  for (let i = 0; i < 5; i += 1) await processInbound(msg(attacker, `LINK ${generateCode()}`), f.send);
  assert.equal(f.sent.length, 5);
  const { code } = await startLink(user.id); // even the right code no longer works from this number
  await processInbound(msg(attacker, `LINK ${code}`), f.send);
  assert.equal(f.sent.length, 5); // locked: no reply
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).phoneNumber, null);
});

test("whatsapp link: a code links to its own account only; a number linked elsewhere is refused", { skip }, async () => {
  resetLinkFailures();
  const a = await makeUser();
  const bNumber = randomNumber();
  const b = await makeUser({ linkedNumber: bNumber });
  const f = fakeSender();
  const { code } = await startLink(a.id);
  await processInbound(msg(bNumber, `LINK ${code}`), f.send); // B's number with A's code
  assert.equal(f.sent.at(-1)?.body, LINK_FAILED_REPLY);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: a.id } })).phoneNumber, null);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: b.id } })).phoneNumber, bNumber);
  // A free account can't be linked even with a valid code
  const free = await makeUser({ tier: "FREE" });
  const freeCode = await startLink(free.id);
  await processInbound(msg(randomNumber(), `LINK ${freeCode.code}`), f.send);
  assert.equal(f.sent.at(-1)?.body, LINK_FAILED_REPLY);
});

test("whatsapp routing: unlinked → instructions once an hour; Free → Pro notice once a day, nothing processed; Pro → answered", { skip }, async () => {
  resetInboundState();
  const f = fakeSender();
  const stranger = randomNumber();
  await processInbound(msg(stranger, "hi"), f.send);
  await processInbound(msg(stranger, "hello?"), f.send);
  assert.deepEqual(f.sent.map((s) => s.body), [UNLINKED_REPLY]);

  const freeNumber = randomNumber();
  const free = await makeUser({ tier: "FREE", linkedNumber: freeNumber });
  await processInbound(msg(freeNumber, "Add submit report due tomorrow 5 PM"), f.send);
  await processInbound(msg(freeNumber, "Add another thing tomorrow"), f.send);
  assert.deepEqual(f.sent.slice(1).map((s) => s.body), [PRO_ONLY_REPLY]);
  assert.equal(await prisma.task.count({ where: { userId: free.id } }), 0);

  const proNumber = randomNumber();
  await makeUser({ linkedNumber: proNumber });
  await processInbound(msg(proNumber, "What's due today?"), f.send);
  assert.equal(f.sent.at(-1)?.to, proNumber);
  assert.match(f.sent.at(-1)?.body ?? "", /nothing due today/i);
});

test("whatsapp: the crisis check runs on WhatsApp messages too", { skip }, async () => {
  resetInboundState();
  const number = randomNumber();
  await makeUser({ linkedNumber: number });
  const f = fakeSender();
  await processInbound(msg(number, "I want to kill myself"), f.send);
  const reply = f.sent.at(-1)?.body ?? "";
  assert.ok(reply.includes(CRISIS_RESOURCES.emergency), `crisis resources missing in: ${reply}`);
});

async function reminderFixture(opts: { quietNow?: boolean } = {}) {
  resetWhatsappPause();
  const number = randomNumber();
  const user = await makeUser({ linkedNumber: number, ...quiet(Boolean(opts.quietNow)) });
  const now = new Date();
  const task = await prisma.task.create({ data: { userId: user.id, title: "Submit lab report", dueAt: new Date(now.getTime() + 3 * 3600000), priority: Priority.HIGH } });
  const log = await prisma.reminderLog.create({ data: { userId: user.id, taskId: task.id, fireAt: new Date(now.getTime() - 60000), level: "normal" } });
  return { user, number, task, log, now };
}

test("whatsapp reminders: sent once, stored in the chat, and 'done' completes the reminded task", { skip }, async () => {
  const { number, task, log, now } = await reminderFixture();
  const f = fakeSender();
  const [a, b] = await Promise.all([sendDueWhatsappReminders(now, f.send), sendDueWhatsappReminders(now, f.send)]); // overlapping runs
  assert.equal(a + b, 1);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].body, /Submit lab report/);
  assert.equal((await prisma.reminderLog.findUniqueOrThrow({ where: { id: log.id } })).status, "SENT_WHATSAPP");

  resetInboundState();
  await processInbound(msg(number, "done"), f.send);
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status, TaskStatus.COMPLETED);
});

test("whatsapp reminders: quiet hours at send time → skipped, nothing sent", { skip }, async () => {
  const { log, now } = await reminderFixture({ quietNow: true });
  const f = fakeSender();
  assert.equal(await sendDueWhatsappReminders(now, f.send), 0);
  assert.equal(f.sent.length, 0);
  assert.equal((await prisma.reminderLog.findUniqueOrThrow({ where: { id: log.id } })).status, "SKIPPED");
});

test("whatsapp reminders: closed 24 h window → skipped; transient error → retried; other errors → failed", { skip }, async () => {
  const cases: Array<[SendResult, string]> = [
    [{ ok: false, twilioCode: TWILIO_WINDOW_CLOSED }, "SKIPPED"],
    [{ ok: false, twilioCode: null, transient: true }, "SCHEDULED"],
    [{ ok: false, twilioCode: 21211 }, "FAILED"],
  ];
  for (const [result, status] of cases) {
    const { log, now } = await reminderFixture();
    await sendDueWhatsappReminders(now, fakeSender(result).send);
    assert.equal((await prisma.reminderLog.findUniqueOrThrow({ where: { id: log.id } })).status, status, JSON.stringify(result));
  }
});

test("whatsapp reminders: an on-time 'due now' reminder still goes out when the job runs a few minutes late", { skip }, async () => {
  resetWhatsappPause();
  const number = randomNumber();
  const user = await makeUser({ linkedNumber: number, ...quiet(false) });
  const dueAt = new Date(Math.floor((Date.now() - 3 * 60000) / 60000) * 60000); // due 3 min ago, on the minute
  const task = await prisma.task.create({ data: { userId: user.id, title: "Hand in form", dueAt, dueTime: "1:00 PM" } });
  const log = await prisma.reminderLog.create({ data: { userId: user.id, taskId: task.id, fireAt: dueAt, level: "critical" } });
  const f = fakeSender();
  assert.equal(await sendDueWhatsappReminders(new Date(), f.send), 1);
  assert.equal((await prisma.reminderLog.findUniqueOrThrow({ where: { id: log.id } })).status, "SENT_WHATSAPP");
});

test("whatsapp reminders: the 24 h window is checked at send time, not at the planned time", { skip }, async () => {
  resetWhatsappPause();
  const { log, now, user } = await reminderFixture();
  await prisma.userSettings.update({ where: { userId: user.id }, data: { lastWhatsappMessageAt: new Date(now.getTime() - 24 * 3600000 - 30000) } }); // window closed 30 s ago
  const f = fakeSender();
  assert.equal(await sendDueWhatsappReminders(now, f.send), 0);
  assert.equal(f.sent.length, 0);
  assert.equal((await prisma.reminderLog.findUniqueOrThrow({ where: { id: log.id } })).status, "SCHEDULED"); // left to the phone
});

test("whatsapp: messages stuck as RECEIVED for 2+ minutes get 'please resend' once", { skip }, async () => {
  const sid = `SMtest${randomUUID()}`;
  const number = randomNumber();
  await prisma.whatsappInbound.create({ data: { messageSid: sid, fromNumber: `whatsapp:${number}`, createdAt: new Date(Date.now() - 3 * 60000) } });
  const f = fakeSender();
  await recoverStuckInbound(new Date(), f.send);
  await recoverStuckInbound(new Date(), f.send);
  assert.deepEqual(f.sent.filter((s) => s.to === number).map((s) => s.body), [MISSED_REPLY]);
  assert.equal((await prisma.whatsappInbound.findUniqueOrThrow({ where: { messageSid: sid } })).status, "DONE");
});
