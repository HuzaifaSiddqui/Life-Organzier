import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { prisma } from "../src/config/db.js";
import { resetMissedReminderState, sendMissedPhoneReminders } from "../src/modules/push/missedReminders.js";
import { changesUserData, dueWindow, fcmData, fcmMessage, fcmTokenGone, isExpoToken, missedOnPhone } from "../src/modules/push/pushRules.js";
import { RoutingPushProvider, scheduleSyncPush, setPushProvider, type PushMessage, type PushProvider } from "../src/modules/push/pushService.js";
import { dbAvailable } from "./fixtures.js";

/** Push through Firebase Cloud Messaging and the silent "sync" push to the user's other phones. */

test("push rules: token kinds, which requests change data, FCM payload, dead tokens", () => {
  assert.equal(isExpoToken("ExponentPushToken[abc]"), true);
  assert.equal(isExpoToken("ExpoPushToken[abc]"), true);
  assert.equal(isExpoToken("fMx1:APA91bH-device-token"), false);

  assert.equal(changesUserData("POST", "/api/tasks", {}), true);
  assert.equal(changesUserData("PATCH", "/api/routines/occurrences/1", {}), true);
  assert.equal(changesUserData("POST", "/api/assistant/message", {}), true);
  assert.equal(changesUserData("GET", "/api/tasks", {}), false);
  assert.equal(changesUserData("POST", "/api/sync", { mutations: [] }), false, "a plain pull changes nothing");
  assert.equal(changesUserData("POST", "/api/sync?x=1", { mutations: [{}] }), true);
  assert.equal(changesUserData("POST", "/api/events", {}), false);
  assert.equal(changesUserData("POST", "/api/push/register", {}), false);

  assert.deepEqual(fcmData({ title: "Added from WhatsApp", body: "Buy milk", data: { type: "sync", n: 2, skip: null } }), { type: "sync", n: "2", loTitle: "Added from WhatsApp", loBody: "Buy milk" });
  assert.deepEqual(fcmData({}), { type: "sync" });
  assert.equal(fcmTokenGone("messaging/registration-token-not-registered"), true);
  assert.equal(fcmTokenGone("messaging/internal-error"), false);
});

function recorder(name: string, fail: Set<string> = new Set()) {
  const sent: PushMessage[] = [];
  const p: PushProvider = {
    send: async (msgs) => {
      sent.push(...msgs);
      return msgs.map((m) => (fail.has(m.to) ? { error: "DeviceNotRegistered" } : { id: `${name}-${m.to}` }));
    },
    receipts: async () => ({}),
  };
  return { p, sent };
}

test("push routing: Expo tokens through Expo, device tokens through FCM, results in order", async () => {
  const expo = recorder("expo");
  const fcm = recorder("fcm");
  const r = new RoutingPushProvider(expo.p, fcm.p);
  const out = await r.send([
    { to: "fcm-1", title: "", body: "" },
    { to: "ExponentPushToken[a]", title: "", body: "" },
    { to: "fcm-2", title: "", body: "" },
  ]);
  assert.deepEqual(out.map((t) => t.id), ["fcm-fcm-1", "expo-ExponentPushToken[a]", "fcm-fcm-2"]);
  assert.deepEqual(expo.sent.map((m) => m.to), ["ExponentPushToken[a]"]);
});

test("silent sync push: one per burst, not to the device that made the change, dead tokens removed", { skip: !dbAvailable && "no database" }, async () => {
  const user = await prisma.user.create({ data: { firebaseUid: `push-${randomUUID()}`, email: `push-${randomUUID().slice(0, 8)}@example.test` } });
  const rec = recorder("fcm", new Set(["fcm-gone"]));
  setPushProvider(rec.p);
  try {
    await prisma.pushToken.createMany({
      data: [
        { userId: user.id, token: "fcm-phone", platform: "android", deviceId: "phone" },
        { userId: user.id, token: "fcm-maker", platform: "android", deviceId: "maker" },
        { userId: user.id, token: "fcm-gone", platform: "android", deviceId: "old" },
        { userId: user.id, token: "ExponentPushToken[x]", platform: "android", deviceId: "expo" },
      ],
    });
    scheduleSyncPush(user.id, "maker");
    scheduleSyncPush(user.id, "maker");
    await new Promise((r) => setTimeout(r, 3200));
    assert.deepEqual(rec.sent.map((m) => m.to).sort(), ["fcm-gone", "fcm-phone"], "one push each, not to the maker, no Expo token");
    assert.equal(rec.sent[0].data?.type, "sync");
    assert.equal(await prisma.pushToken.count({ where: { token: "fcm-gone" } }), 0);
  } finally {
    setPushProvider(new RoutingPushProvider());
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
});

test("reminder job timing: runs just after each whole minute", async () => {
  const { msToNextMinute } = await import("../src/jobs/maintenance.js");
  assert.equal(msToNextMinute(Date.parse("2026-11-16T21:02:51Z")), 9000);
  assert.equal(msToNextMinute(Date.parse("2026-11-16T21:02:00Z")), 0);
  assert.equal(msToNextMinute(Date.parse("2026-11-16T21:02:00.250Z")), 59750);
});

test("missed reminders: which phones missed a change, the due window, a visible FCM message", () => {
  const t = (iso: string) => new Date(iso);
  assert.equal(missedOnPhone(null, t("2026-11-17T02:35:00Z")), true, "never fetched a plan on this install");
  assert.equal(missedOnPhone(t("2026-11-17T02:30:00Z"), t("2026-11-17T02:35:00Z")), true, "task changed after the last plan");
  assert.equal(missedOnPhone(t("2026-11-17T02:36:00Z"), t("2026-11-17T02:35:00Z")), false, "the phone has it");

  const now = Date.parse("2026-11-17T02:37:01Z");
  assert.deepEqual(dueWindow(null, now), { from: now - 60000, to: now });
  assert.deepEqual(dueWindow(now - 60000, now), { from: now - 60000, to: now });
  assert.deepEqual(dueWindow(now - 3600000, now), { from: now - 5 * 60000, to: now }, "a long pause doesn't send old reminders");

  const silent = fcmMessage({ to: "tok", title: "Added from WhatsApp", body: "Milk" });
  assert.equal(silent.notification, undefined);
  assert.equal(silent.data.loTitle, "Added from WhatsApp");
  const shown = fcmMessage({ to: "tok", title: "Translate water", body: "Due 7:37 AM", data: { kind: "lo-reminder", taskId: "t1" }, notify: { channelId: "lo-sound", tag: "lo:t1" } });
  assert.deepEqual(shown.notification, { title: "Translate water", body: "Due 7:37 AM" });
  assert.deepEqual(shown.data, { kind: "lo-reminder", taskId: "t1" }, "no loTitle: Android shows it, not the app");
  assert.equal(shown.android.notification?.channelId, "lo-sound");
  assert.equal(shown.android.notification?.tag, "lo:t1");
});

test("missed reminders job: a visible push only to the phone that hasn't got the change", { skip: !dbAvailable && "no database" }, async () => {
  const now = new Date();
  const user = await prisma.user.create({ data: { firebaseUid: `missed-${randomUUID()}`, email: `missed-${randomUUID().slice(0, 8)}@example.test` } });
  const rec = recorder("fcm");
  setPushProvider(rec.p);
  resetMissedReminderState();
  try {
    // remindersPlannedAt is current, so the job uses the stored reminder rows as they are.
    await prisma.userSettings.create({ data: { userId: user.id, timezone: "Asia/Karachi", remindersPlannedAt: new Date(now.getTime() + 1000) } });
    const task = await prisma.task.create({ data: { userId: user.id, title: "Translate water", dueAt: new Date(now.getTime() + 60000) } });
    await prisma.reminderLog.create({ data: { userId: user.id, taskId: task.id, fireAt: new Date(now.getTime() - 20000), level: "normal" } });
    await prisma.pushToken.createMany({
      data: [
        { userId: user.id, token: "fcm-stale", platform: "android", deviceId: "stale", planSyncedAt: new Date(now.getTime() - 3600000) },
        { userId: user.id, token: "fcm-fresh", platform: "android", deviceId: "fresh", planSyncedAt: new Date(now.getTime() + 1000) },
      ],
    });
    assert.equal(await sendMissedPhoneReminders(now), 1);
    assert.deepEqual(rec.sent.map((m) => m.to), ["fcm-stale"]);
    assert.equal(rec.sent[0].title, "Translate water");
    assert.equal(rec.sent[0].notify?.tag, `lo:${task.id}`);
    assert.equal(await sendMissedPhoneReminders(new Date(now.getTime() + 1000)), 0, "never twice");
  } finally {
    setPushProvider(new RoutingPushProvider());
    resetMissedReminderState();
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
});
