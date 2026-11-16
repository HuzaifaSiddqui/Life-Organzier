import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { prisma } from "../src/config/db.js";
import { useTestAuth } from "../src/config/firebase.js";
import { runMaintenance } from "../src/jobs/maintenance.js";
import { GUEST_UNUSED_DAYS, guestModeOn, LAST_SEEN_EVERY_MS, shouldTouchLastSeen, staleGuestCutoff, syncDecision } from "../src/modules/guest/guestRules.js";
import { dbAvailable } from "./fixtures.js";

/** Guest mode (FR-OB-003): rules, the routes a guest may and may not use, converting, discarding and cleanup. */

test("guest rules: GUEST_MODE switch and what sync-user does with a token", () => {
  assert.equal(guestModeOn({ GUEST_MODE: "on" }), true);
  assert.equal(guestModeOn({ GUEST_MODE: " ON " }), true);
  assert.equal(guestModeOn({}), false);
  assert.equal(guestModeOn({ GUEST_MODE: "off" }), false);

  assert.equal(syncDecision({ uid: "a", email: "a@b.c", provider: "password" }, false), "account");
  // A converted guest: same uid, the anonymous account now has an email.
  assert.equal(syncDecision({ uid: "a", email: "a@b.c", provider: "anonymous" }, true), "account");
  assert.equal(syncDecision({ uid: "a", provider: "anonymous" }, true), "guest");
  assert.equal(syncDecision({ uid: "a", provider: "anonymous" }, false), "guest_mode_off");
  assert.equal(syncDecision({ uid: "a", provider: "phone" }, true), "no_email");
});

test("guest rules: last-seen writes are throttled; unused guests go after 60 days", () => {
  const now = new Date("2026-11-16T10:00:00Z");
  assert.equal(shouldTouchLastSeen(null, now), true);
  assert.equal(shouldTouchLastSeen(new Date(now.getTime() - LAST_SEEN_EVERY_MS + 1000), now), false);
  assert.equal(shouldTouchLastSeen(new Date(now.getTime() - LAST_SEEN_EVERY_MS), now), true);
  assert.equal(now.getTime() - staleGuestCutoff(now).getTime(), GUEST_UNUSED_DAYS * 86_400_000);
});

const skip = !dbAvailable && "no database";

/** Token = "<uid>" for a guest, "<uid>|<email>" for an account (the test checker stands in for Firebase). */
const deleted: string[] = [];
function fakeFirebase() {
  useTestAuth({
    verifyIdToken: async (token: string) => {
      const [uid, email] = token.split("|");
      return { uid, email, firebase: { sign_in_provider: email ? "password" : "anonymous" } } as never;
    },
    deleteUser: async (uid: string) => void deleted.push(uid),
  } as never);
}

test("guest routes: a guest signs in, uses the app, is refused account-only features, converts and keeps the data", { skip }, async () => {
  const keep = { NODE_ENV: process.env.NODE_ENV, GUEST_MODE: process.env.GUEST_MODE, COLLAB_TASKS: process.env.COLLAB_TASKS };
  process.env.NODE_ENV = "test";
  process.env.GUEST_MODE = "on";
  process.env.COLLAB_TASKS = "on";
  fakeFirebase();
  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as { error?: string; data?: Record<string, unknown> } };
  };
  const uid = `guest-${randomUUID()}`;
  try {
    // Sign in as a guest: a user with no email.
    assert.equal((await call(uid, "POST", "/auth/sync-user")).status, 200);
    const guest = await prisma.user.findUniqueOrThrow({ where: { firebaseUid: uid } });
    assert.equal(guest.isGuest, true);
    assert.equal(guest.email, null);

    // Normal features work.
    assert.equal((await call(uid, "PUT", "/settings", { language: "ur" })).status, 200);
    assert.equal((await call(uid, "POST", "/tasks", { title: "Guest task", priority: "MEDIUM" })).status < 300, true);

    // Account-only features are refused with ACCOUNT_REQUIRED; read-only status stays open (the app dims the card).
    for (const [method, path, body] of [
      ["POST", "/whatsapp/link/start", {}],
      ["POST", "/whatsapp-agent/connect", { apiKey: "x".repeat(40) }],
      ["GET", "/collab/connections", undefined],
      ["PUT", "/settings", { tier: "PRO" }],
      ["PUT", "/settings", { notificationDevices: "WHATSAPP" }],
    ] as const) {
      const r = await call(uid, method, path, body);
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal(r.json.error, "ACCOUNT_REQUIRED", `${method} ${path}`);
    }
    assert.notEqual((await call(uid, "GET", "/collab/me")).status, 403, "the People summary stays readable");
    assert.notEqual((await call(uid, "GET", "/whatsapp-agent/status")).status, 403, "the Agent status stays readable");

    // Converting: the same Firebase account now has an email. Same user, data kept, no longer a guest.
    const email = `conv-${randomUUID().slice(0, 8)}@example.test`;
    assert.equal((await call(`${uid}|${email}`, "POST", "/auth/sync-user")).status, 200);
    const converted = await prisma.user.findUniqueOrThrow({ where: { firebaseUid: uid } });
    assert.equal(converted.id, guest.id);
    assert.equal(converted.isGuest, false);
    assert.equal(converted.email, email);
    assert.equal(await prisma.task.count({ where: { userId: guest.id, title: "Guest task" } }), 1);
    // An account can't be discarded like a guest.
    assert.equal((await call(`${uid}|${email}`, "POST", "/account/guest/discard")).status, 403);
  } finally {
    await prisma.user.deleteMany({ where: { firebaseUid: uid } });
    server.close();
    Object.assign(process.env, keep);
    for (const [k, v] of Object.entries(keep)) if (v === undefined) delete process.env[k];
  }
});

test("guest routes: GUEST_MODE off refuses guests; Start fresh discards a guest and its Firebase account", { skip }, async () => {
  const keep = { NODE_ENV: process.env.NODE_ENV, GUEST_MODE: process.env.GUEST_MODE };
  process.env.NODE_ENV = "test";
  fakeFirebase();
  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const post = async (token: string, path: string) => fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  const uid = `guest-${randomUUID()}`;
  try {
    process.env.GUEST_MODE = "off";
    const off = await post(uid, "/auth/sync-user");
    assert.equal(off.status, 403);
    assert.equal(((await off.json()) as { error: string }).error, "GUEST_MODE_OFF");

    process.env.GUEST_MODE = "on";
    assert.equal((await post(uid, "/auth/sync-user")).status, 200);
    const guest = await prisma.user.findUniqueOrThrow({ where: { firebaseUid: uid } });
    await prisma.task.create({ data: { userId: guest.id, title: "Throwaway" } });
    assert.equal((await post(uid, "/account/guest/discard")).status, 200);
    assert.equal(await prisma.user.count({ where: { id: guest.id } }), 0);
    assert.equal(await prisma.task.count({ where: { userId: guest.id } }), 0, "data goes with the guest");
    assert.ok(deleted.includes(uid), "the Firebase guest account is deleted too");
  } finally {
    await prisma.user.deleteMany({ where: { firebaseUid: uid } });
    server.close();
    Object.assign(process.env, keep);
    for (const [k, v] of Object.entries(keep)) if (v === undefined) delete process.env[k];
  }
});

test("guest cleanup: guests unused for 60 days are deleted; recent guests and accounts stay", { skip }, async () => {
  const keepEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  fakeFirebase();
  const now = new Date();
  const old = new Date(now.getTime() - (GUEST_UNUSED_DAYS + 1) * 86_400_000);
  const make = (data: { isGuest: boolean; lastSeenAt?: Date | null; createdAt?: Date; email?: string | null }) =>
    prisma.user.create({ data: { firebaseUid: `cleanup-${randomUUID()}`, email: data.email ?? null, isGuest: data.isGuest, lastSeenAt: data.lastSeenAt ?? null, createdAt: data.createdAt } });
  const staleSeen = await make({ isGuest: true, lastSeenAt: old });
  const staleNever = await make({ isGuest: true, createdAt: old });
  const recent = await make({ isGuest: true, lastSeenAt: now });
  const account = await make({ isGuest: false, lastSeenAt: old, email: `old-${randomUUID().slice(0, 8)}@example.test` });
  try {
    await runMaintenance(now);
    const left = new Set((await prisma.user.findMany({ where: { id: { in: [staleSeen.id, staleNever.id, recent.id, account.id] } }, select: { id: true } })).map((u) => u.id));
    assert.equal(left.has(staleSeen.id), false, "unused guest (last seen long ago) deleted");
    assert.equal(left.has(staleNever.id), false, "unused guest (never seen, created long ago) deleted");
    assert.equal(left.has(recent.id), true, "recent guest kept");
    assert.equal(left.has(account.id), true, "accounts are never deleted by this");
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [staleSeen.id, staleNever.id, recent.id, account.id] } } });
    process.env.NODE_ENV = keepEnv;
  }
});
