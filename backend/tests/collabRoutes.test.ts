import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { SharedTaskKind, type User } from "@prisma/client";
import { prisma } from "../src/config/db.js";
import { useTestAuth } from "../src/config/firebase.js";
import { acceptSharedTask, cancelSharedTask, createSharedTask, rejectSharedTask, removeMember, requestConnection, respondConnection } from "../src/modules/collab/collabService.js";
import { requestLimiter, searchLimiter } from "../src/modules/collab/collabRoutes.js";
import { setPushProvider } from "../src/modules/push/pushService.js";
import { dbAvailable, TZ } from "./fixtures.js";

/**
 * COLLAB_TASKS route checks over HTTP (the real app and middleware; a test token checker stands in for Firebase).
 * Every route is called by a stranger, a member who hasn't accepted, one who declined and one who was removed.
 */
const skip = !dbAvailable && "no database";

async function person(name: string): Promise<User> {
  const tag = randomUUID().slice(0, 8);
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `${name}-${tag}@example.test`, username: `${name}_${tag}`.slice(0, 20) } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ } });
  return user;
}

async function connect(a: User, b: User): Promise<string> {
  const r = await requestConnection(a, b.id);
  await respondConnection(b, r.connectionId, true);
  return r.connectionId;
}

test("collab routes: strangers, non-accepted, declined and removed members are refused on every route", { skip }, async () => {
  const keepEnv = { NODE_ENV: process.env.NODE_ENV, COLLAB_TASKS: process.env.COLLAB_TASKS };
  process.env.NODE_ENV = "test";
  process.env.COLLAB_TASKS = "on";
  setPushProvider({ send: async (msgs) => msgs.map(() => ({ id: randomUUID() })), receipts: async () => ({}) });
  useTestAuth({ verifyIdToken: async (token: string) => ({ uid: token }) as never });
  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/collab`;
  const call = async (who: User, method: string, path: string, body?: unknown) =>
    (await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${who.firebaseUid}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).status;

  try {
    const owner = await person("own");
    const pending = await person("pen");
    const declined = await person("dec");
    const removed = await person("rem");
    const stranger = await person("str");
    const ownerToPending = await connect(owner, pending);
    await connect(owner, declined);
    await connect(owner, removed);
    const { shared } = await createSharedTask(owner, TZ, { kind: SharedTaskKind.COLLAB, memberIds: [pending.id, declined.id, removed.id], title: "Group report", priority: "MEDIUM" });
    await rejectSharedTask(declined, TZ, shared.id);
    await acceptSharedTask(removed, TZ, shared.id);
    await removeMember(owner, shared.id, removed.id);
    const id = shared.id;
    const refused = { stranger, declined, removed };
    const all = { ...refused, pending };

    // Owner-only routes: nobody else, not even a pending member.
    for (const [who, u] of Object.entries(all)) {
      assert.equal(await call(u, "PATCH", `/tasks/${id}`, { title: "Mine now" }), 404, `${who}: edit`);
      assert.equal(await call(u, "POST", `/tasks/${id}/resend`, { userId: declined.id }), 404, `${who}: resend`);
      assert.equal(await call(u, "DELETE", `/tasks/${id}/members/${pending.id}`), 404, `${who}: remove a member`);
      assert.equal(await call(u, "DELETE", `/tasks/${id}`), 404, `${who}: cancel`);
    }
    // Member routes: no access once declined or removed, and never for a stranger.
    for (const [who, u] of Object.entries(refused)) {
      assert.equal(await call(u, "GET", `/tasks/${id}`), 404, `${who}: view`);
      assert.equal(await call(u, "POST", `/tasks/${id}/accept`, {}), 404, `${who}: accept`);
      assert.equal(await call(u, "POST", `/tasks/${id}/reject`), 404, `${who}: reject`);
      assert.equal(await call(u, "POST", `/tasks/${id}/leave`), 404, `${who}: leave`);
      const list = await (await fetch(`${base}/tasks`, { headers: { authorization: `Bearer ${u.firebaseUid}` } })).json();
      assert.ok(![...list.data.cards, ...list.data.shared].some((s: { id: string }) => s.id === id), `${who}: not in their list`);
    }
    // A pending member may view the card (to answer it), but nothing else of the owner's.
    assert.equal(await call(pending, "GET", `/tasks/${id}`), 200, "pending: view the card");

    // Connections: only the two people on a connection can answer or remove it.
    const fresh = await requestConnection(owner, (await person("frs")).id);
    assert.equal(await call(stranger, "POST", `/connections/${fresh.connectionId}/accept`), 404, "stranger: accept someone else's request");
    assert.equal(await call(stranger, "POST", `/connections/${fresh.connectionId}/reject`), 404, "stranger: decline it");
    assert.equal(await call(stranger, "DELETE", `/connections/${ownerToPending}`), 404, "stranger: remove someone else's connection");
    assert.equal(await call(owner, "POST", `/connections/${fresh.connectionId}/accept`), 404, "the sender can't accept their own request");

    // Notices: each person reads and marks only their own.
    const ownerUnread = await prisma.collabNotice.count({ where: { userId: owner.id, readAt: null } });
    assert.ok(ownerUnread > 0);
    const strangerNotices = await (await fetch(`${base}/notices`, { headers: { authorization: `Bearer ${stranger.firebaseUid}` } })).json();
    assert.deepEqual(strangerNotices.data.notices, []);
    assert.equal(await call(stranger, "POST", "/notices/read"), 200);
    assert.equal(await prisma.collabNotice.count({ where: { userId: owner.id, readAt: null } }), ownerUnread, "a stranger can't mark mine read");

    // Sharing needs an accepted connection.
    assert.equal(await call(stranger, "POST", "/tasks", { kind: "ASSIGN", memberIds: [owner.id], title: "Hi", priority: "LOW" }), 403, "stranger: share with someone not connected");

    // Cancelled: members lose access, the owner keeps it.
    await acceptSharedTask(pending, TZ, id);
    await cancelSharedTask(owner, id);
    assert.equal(await call(pending, "GET", `/tasks/${id}`), 404, "cancelled: member loses access");
    assert.equal(await call(pending, "POST", `/tasks/${id}/leave`), 404);
    assert.equal(await call(owner, "GET", `/tasks/${id}`), 200, "the owner still sees it");

    // Per-user rate limits: search 30 a minute, connection requests 20 an hour (429 after that, others unaffected).
    searchLimiter.reset();
    requestLimiter.reset();
    for (let i = 0; i < 30; i += 1) assert.equal(await call(stranger, "GET", "/users/search?q=abc"), 200);
    assert.equal(await call(stranger, "GET", "/users/search?q=abc"), 429, "31st search in a minute");
    assert.equal(await call(owner, "GET", "/users/search?q=abc"), 200, "per user: someone else can still search");
    for (let i = 0; i < 20; i += 1) assert.equal(await call(stranger, "POST", "/connections", { userId: (await person(`rq${i}`)).id }), 200);
    assert.equal(await call(stranger, "POST", "/connections", { userId: (await person("rqx")).id }), 429, "21st request in an hour");
  } finally {
    server.close();
    useTestAuth(null);
    searchLimiter.reset();
    requestLimiter.reset();
    process.env.NODE_ENV = keepEnv.NODE_ENV;
    process.env.COLLAB_TASKS = keepEnv.COLLAB_TASKS;
  }
});
