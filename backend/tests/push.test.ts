import assert from "node:assert/strict";
import crypto, { randomUUID } from "node:crypto";
import test from "node:test";
import type { UserSettings } from "@prisma/client";
import { prisma } from "../src/config/db.js";
import { handleAssistantMessage } from "../src/modules/assistant/dialogue.js";
import { createRequire } from "node:module";
import type * as PushQueue from "../../mobile/src/utils/pushQueue.js";
import { checkPushReceipts, registerPushToken, resetPushState, sendPushToUser, setPushProvider, unregisterDeviceToken, unregisterPushToken, type PushMessage, type PushProvider, type PushTicket } from "../src/modules/push/pushService.js";
import { processInbound, resetInboundState } from "../src/modules/whatsapp/inbound.js";
import type { SendResult } from "../src/modules/whatsapp/whatsappService.js";
import { dbAvailable } from "./fixtures.js";
import { backgroundSettled } from "../src/lib/background.js";

const skip = !dbAvailable && "no database";
const H = 3600000;
// The phone's unregister queue is pure, like answerQueue (mobile/ isn't an ES-module package, hence require).
const { enqueueUnregister, flushUnregisterQueue, withoutToken } = createRequire(import.meta.url)("../../mobile/src/utils/pushQueue.ts") as typeof PushQueue;

/* ------------------------------------------------------------------ pure */

test("push sign-out queue: kept while offline, retried later, cancelled by signing back in, dropped on 4xx", async () => {
  const signedOut = new Date("2026-10-17T10:00:00Z");
  const item = (token: string) => ({ token, deviceId: "device-123456", respondedAt: signedOut.toISOString() });
  let queue = enqueueUnregister([], item("T1"));
  queue = enqueueUnregister(queue, item("T1")); // once per token
  queue = enqueueUnregister(queue, item("T2"));
  assert.deepEqual(queue.map((q) => q.token), ["T1", "T2"]);

  // offline: nothing delivered, nothing counted as an attempt, the flush stops, both kept
  const offline = await flushUnregisterQueue(queue, async () => { throw new Error("no network"); }, () => "offline", new Date(signedOut.getTime() + 60000));
  assert.deepEqual(offline.map((q) => [q.token, q.attempts ?? 0]), [["T1", 0], ["T2", 0]]);

  // back online: T1 succeeds, T2 gets a 5xx and is kept with one attempt
  const delivered: string[] = [];
  const later = await flushUnregisterQueue(offline, async (q) => { if (q.token === "T2") throw new Error("503"); delivered.push(q.token); }, () => "server", new Date(signedOut.getTime() + 3600000));
  assert.deepEqual(delivered, ["T1"]);
  assert.deepEqual(later.map((q) => [q.token, q.attempts]), [["T2", 1]]);

  // a 4xx is final; signing back in with a token cancels its pending unregister
  assert.deepEqual(await flushUnregisterQueue(later, async () => { throw new Error("400"); }, () => "client"), []);
  assert.deepEqual(withoutToken(queue, "T1").map((q) => q.token), ["T2"]);
  // given up after 48 h even if still offline
  assert.deepEqual(await flushUnregisterQueue(queue, async () => { throw new Error("x"); }, () => "offline", new Date(signedOut.getTime() + 49 * H)), []);
});

/* ------------------------------------------------------------------ database */

function fakeProvider() {
  const sent: PushMessage[] = [];
  const state = { tickets: null as null | ((msgs: PushMessage[]) => PushTicket[]), receipts: {} as Record<string, string | null>, receiptCalls: 0 };
  const provider: PushProvider = {
    send: async (msgs) => {
      sent.push(...msgs);
      return state.tickets ? state.tickets(msgs) : msgs.map(() => ({ id: `ticket-${randomUUID()}` }));
    },
    receipts: async () => {
      state.receiptCalls += 1;
      return state.receipts;
    },
  };
  return { sent, state, provider };
}

function fakeSender(result: SendResult = { ok: true, twilioCode: null }) {
  const sent: Array<{ to: string; body: string }> = [];
  return { sent, send: async (to: string, body: string) => (sent.push({ to, body }), result) };
}

const created: string[] = [];
const randomNumber = () => `+92300${crypto.randomInt(1000000, 9999999)}`;
const token = () => `ExponentPushToken[${randomUUID()}]`;

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

const msg = (from: string, body: string) => ({ sid: `SMtest${randomUUID()}`, from: `whatsapp:${from}`, body, numMedia: 0, mediaType: "", mediaUrl: "" });

test.after(async () => {
  if (!dbAvailable) return;
  await prisma.user.deleteMany({ where: { id: { in: created } } });
  await prisma.whatsappInbound.deleteMany({ where: { messageSid: { startsWith: "SMtest" } } });
});

test("push: register, move between accounts, unregister only by the owner", { skip }, async () => {
  const a = (await makeUser()).user;
  const b = (await makeUser()).user;
  const t = token();
  await registerPushToken(a.id, { token: t, platform: "android", deviceId: "d1" });
  assert.equal((await prisma.pushToken.findUniqueOrThrow({ where: { token: t } })).userId, a.id);
  await registerPushToken(b.id, { token: t, platform: "android" }); // same phone, other account
  assert.equal((await prisma.pushToken.findUniqueOrThrow({ where: { token: t } })).userId, b.id);
  assert.equal(await unregisterPushToken(a.id, t), false);
  assert.equal(await unregisterPushToken(b.id, t), true);
  assert.equal(await prisma.pushToken.count({ where: { token: t } }), 0);
});

test("push: the sign-out retry (no login) removes a token only with the matching device id", { skip }, async () => {
  const u = (await makeUser()).user;
  const t = token();
  await registerPushToken(u.id, { token: t, platform: "android", deviceId: "device-abcdef" });
  assert.equal(await unregisterDeviceToken(t, "device-wrong1"), false);
  assert.equal(await prisma.pushToken.count({ where: { token: t } }), 1);
  assert.equal(await unregisterDeviceToken(t, "device-abcdef"), true);
  assert.equal(await prisma.pushToken.count({ where: { token: t } }), 0);
});

test("push: DeviceNotRegistered in a ticket or a later receipt deletes the token", { skip }, async () => {
  resetPushState();
  const f = fakeProvider();
  setPushProvider(f.provider);
  const u = (await makeUser()).user;
  const [live, dead] = [token(), token()];
  await registerPushToken(u.id, { token: live, platform: "android" });
  await registerPushToken(u.id, { token: dead, platform: "android" });
  f.state.tickets = (msgs) => msgs.map((m) => (m.to === dead ? { error: "DeviceNotRegistered" } : { id: "r-live" }));
  assert.equal(await sendPushToUser(u.id, { title: "t", body: "b" }), 1);
  assert.equal(await prisma.pushToken.count({ where: { token: dead } }), 0);

  assert.equal(await checkPushReceipts(Date.now()), 0); // too early: receipts are checked after 15 min
  assert.equal(f.state.receiptCalls, 0);
  f.state.receipts = { "r-live": "DeviceNotRegistered" };
  assert.equal(await checkPushReceipts(Date.now() + 16 * 60000), 1);
  assert.equal(await prisma.pushToken.count({ where: { token: live } }), 0);
});

test("push: a task created from WhatsApp sends 'Added from WhatsApp'; one created in the app does not", { skip }, async () => {
  resetPushState();
  resetInboundState();
  const f = fakeProvider();
  setPushProvider(f.provider);
  const { user, number, settings } = await makeUser();
  await registerPushToken(user.id, { token: token(), platform: "android" });
  await processInbound(msg(number, "Complete math assignment by Friday 3 PM"), fakeSender().send);
  await backgroundSettled(); // the push is fire-and-forget: wait for it, don't sleep
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].title, "Added from WhatsApp");
  assert.match(f.sent[0].body, /math assignment/i);
  assert.deepEqual(f.sent[0].data, { type: "sync" });
  assert.equal(await prisma.task.count({ where: { userId: user.id, source: "WHATSAPP" } }), 1);

  await handleAssistantMessage({ user, settings, deviceId: "phone", text: "Complete physics lab by Friday 4 PM", channel: "APP" });
  await backgroundSettled(); // the push is fire-and-forget: wait for it, don't sleep
  assert.equal(f.sent.length, 1);
});
