import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { inspect } from "node:util";
import { type User, type UserSettings, type WhatsAppAgentConnection } from "@prisma/client";
import { prisma } from "../src/config/db.js";
import { setStt, type SttProvider } from "../src/ai/stt.js";
import { capTurns, dropStaleQuestion, loadContext } from "../src/modules/conversations/conversationContext.js";
import { crisisResponse } from "../src/modules/mood/crisis.js";
import { shutdownOcr } from "../src/modules/documents/textExtraction.js";
import { setPushProvider, type PushMessage } from "../src/modules/push/pushService.js";
import { AgentError, errorFor, ForbiddenError, HttpAgentClient, InvalidKeyError, ConflictError, MediaTooLargeError, NetworkError, RateLimitedError } from "../src/modules/whatsappAgent/client.js";
import { AgentConnectionManager, backoffMs, MISSED_REPLY, setAgentManager, type HandlerIO } from "../src/modules/whatsappAgent/connectionManager.js";
import { agentCopy, CHANNEL, handleAgentUpdate } from "../src/modules/whatsappAgent/inbound.js";
import { PgAdvisoryLock } from "../src/modules/whatsappAgent/lock.js";
import { Outbox, PRIORITY } from "../src/modules/whatsappAgent/outbox.js";
import { ConnectionLimiter, TokenBucket, type Clock } from "../src/modules/whatsappAgent/rateLimiter.js";
import { composeReminder, resetAgentReminderState, sendDueAgentReminders } from "../src/modules/whatsappAgent/reminders.js";
import { decryptSecret, encryptSecret, last4, resetGeneratedSecret } from "../src/modules/whatsappAgent/secrets.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentStatus, connectAgent, disconnectAgent, remindersViaAgent, updateAgentSettings } from "../src/modules/whatsappAgent/service.js";
import { nextOffset, normalizeUpdate, type AgentUpdate } from "../src/modules/whatsappAgent/shapes.js";
import { FakeAgentServer, textPdf } from "./fakes/fakeAgentServer.js";
import { dbAvailable } from "./fixtures.js";

const skip = !dbAvailable && "no database";

/* ------------------------------------------------------------------ secrets in output: captured for the final scan */

const KEY = `WAKEY-${randomUUID()}-SECRET`;
const KEY2 = `WAKEY-${randomUUID()}-OTHER`;
const captured: string[] = [];
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 6 }))).join(" "));
    original(...args);
  };
}
const responses: string[] = [];

process.env.WHATSAPP_KEY_SECRET = "a".repeat(64);

const fake = await new FakeAgentServer().start();
process.env.WHATSAPP_AGENT_BASE_URL = fake.base;
fake.validKeys.add(KEY);
fake.validKeys.add(KEY2);

const pushes: PushMessage[] = [];
setPushProvider({ send: async (m) => (pushes.push(...m), m.map((_, i) => ({ id: `t-${Date.now()}-${i}` }))), receipts: async () => ({}) });

const created: string[] = [];
const managers: AgentConnectionManager[] = [];

test.after(async () => {
  setStt(undefined);
  for (const m of managers) await m.stop().catch(() => undefined);
  setAgentManager(null);
  await fake.stop();
  await shutdownOcr(); // the document test runs the real pipeline, which may start the OCR worker
  if (dbAvailable) await prisma.user.deleteMany({ where: { id: { in: created } } });
});

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A clock whose sleep advances time at once (rate limiter and outbox tests). */
function fakeClock(start = 0): Clock & { t: number; slept: number[] } {
  const c = {
    t: start,
    slept: [] as number[],
    now: () => c.t,
    sleep: async (ms: number) => {
      c.slept.push(ms);
      c.t += ms;
    },
  };
  return c;
}

async function makeUser(over: Partial<UserSettings> = {}): Promise<{ user: User; settings: UserSettings }> {
  const user = await prisma.user.create({
    data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test`, settings: { create: { timezone: "Asia/Karachi", tier: "PRO", ...over } } },
    include: { settings: true },
  });
  created.push(user.id);
  return { user, settings: user.settings as UserSettings };
}

function collectingIO(limiter = new ConnectionLimiter()): HandlerIO & { replies: string[] } {
  const replies: string[] = [];
  return {
    replies,
    limiter,
    client: new HttpAgentClient(KEY, fake.base),
    reply: async (text) => {
      replies.push(text);
      return { ok: true };
    },
  };
}

const update = (over: Partial<AgentUpdate>): AgentUpdate => ({ id: String(Math.floor(Math.random() * 1e9)), kind: "text", text: null, media: null, chatRef: "chat-1", messageId: null, ...over });

/* ================================================================== pure */

test("secrets: AES-256-GCM round trip; bound to the owner; tampering fails; the value never appears", () => {
  const blob = encryptSecret(KEY, "user-a");
  assert.ok(blob.startsWith("v1:"));
  assert.ok(!blob.includes(KEY));
  assert.notEqual(blob, encryptSecret(KEY, "user-a"), "a fresh IV each time");
  assert.equal(decryptSecret(blob, "user-a"), KEY);
  assert.throws(() => decryptSecret(blob, "user-b"), (e: Error) => !e.message.includes(KEY));
  const [v, iv, tag, body] = blob.split(":");
  const flipped = Buffer.from(body, "base64");
  flipped[0] ^= 1;
  assert.throws(() => decryptSecret([v, iv, tag, flipped.toString("base64")].join(":"), "user-a"));
  assert.equal(last4(KEY), KEY.slice(-4));
  const saved = process.env.WHATSAPP_KEY_SECRET;
  process.env.WHATSAPP_KEY_SECRET = "short";
  assert.throws(() => encryptSecret(KEY, "user-a"), /32 bytes/);
  process.env.WHATSAPP_KEY_SECRET = saved;
});

test("secrets: without WHATSAPP_KEY_SECRET the server makes one, keeps it in a file and reuses it", () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-secret-"));
  const saved = process.env.WHATSAPP_KEY_SECRET;
  try {
    delete process.env.WHATSAPP_KEY_SECRET;
    process.env.WHATSAPP_KEY_SECRET_FILE = join(dir, "nested", "whatsapp-key-secret");
    resetGeneratedSecret();
    const blob = encryptSecret(KEY, "user-a");
    assert.ok(existsSync(process.env.WHATSAPP_KEY_SECRET_FILE));
    assert.match(readFileSync(process.env.WHATSAPP_KEY_SECRET_FILE, "utf8"), /^[0-9a-f]{64}$/);
    resetGeneratedSecret(); // a restart: the same secret is read back, so stored keys still decrypt
    assert.equal(decryptSecret(blob, "user-a"), KEY);
  } finally {
    process.env.WHATSAPP_KEY_SECRET = saved;
    delete process.env.WHATSAPP_KEY_SECRET_FILE;
    resetGeneratedSecret();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shapes: text, voice, photo and PDF updates in the assumed and alternative layouts", () => {
  assert.deepEqual(normalizeUpdate({ update_id: 7, message: { chat_id: "c", message_id: "m7", type: "text", text: "hi" } }), { id: "7", kind: "text", text: "hi", media: null, chatRef: "c", messageId: "m7" });
  const voice = normalizeUpdate({ update_id: 8, message: { chat: { id: 42 }, voice: { media_id: "v", mime_type: "audio/ogg; codecs=opus", file_size: 900, duration: 4 } } });
  assert.equal(voice?.kind, "voice");
  assert.deepEqual(voice?.media, { id: "v", mimeType: "audio/ogg; codecs=opus", size: 900, duration: 4, fileName: null });
  assert.equal(voice?.chatRef, "42");
  assert.equal(normalizeUpdate({ id: "u9", message: { image: { id: "img", mime_type: "image/jpeg" }, caption: "timetable" } })?.kind, "image");
  const pdf = normalizeUpdate({ update_id: 10, message: { document: { file_id: "d", mime_type: "application/pdf", file_name: "outline.pdf" } } });
  assert.equal(pdf?.kind, "document");
  assert.equal(pdf?.media?.fileName, "outline.pdf");
  assert.equal(normalizeUpdate({ update_id: 11, message: { document: { file_id: "d2", mime_type: "image/png" } } })?.kind, "image", "an image sent as a file is still an image");
  assert.equal(normalizeUpdate({ update_id: 12, message: { type: "text", text: { body: "nested" } } })?.text, "nested");
  assert.equal(normalizeUpdate({ message: { text: "no id" } }), null);
  assert.equal(nextOffset("41"), "42");
  assert.equal(nextOffset("9007199254740993"), "9007199254740994");
  assert.equal(nextOffset("abc"), "abc");
});

test("client errors: 401 and 400/100 are an invalid key, 403, 409, 429 with Retry-After, 5xx is network", () => {
  assert.ok(errorFor(401, null, null) instanceof InvalidKeyError);
  assert.ok(errorFor(400, { error: { code: 100 } }, null) instanceof InvalidKeyError);
  assert.ok(!(errorFor(400, { error: { code: 131047 } }, null) instanceof InvalidKeyError));
  assert.ok(errorFor(403, { error: { code: 131005 } }, null) instanceof ForbiddenError);
  assert.ok(errorFor(409, null, null) instanceof ConflictError);
  const limited = errorFor(429, null, "12");
  assert.ok(limited instanceof RateLimitedError && limited.retryAfterMs === 12000);
  assert.ok(errorFor(503, null, null) instanceof NetworkError);
});

test("token bucket: 12 at once, then one every 5 s; a 429 blocks until Retry-After", () => {
  const clock = fakeClock();
  const b = new TokenBucket(12, clock);
  for (let i = 0; i < 12; i += 1) assert.equal(b.tryTake(), 0);
  assert.equal(b.tryTake(), 5000);
  clock.t += 5000;
  assert.equal(b.tryTake(), 0);
  b.block(30000);
  assert.equal(b.tryTake(), 30000);
  clock.t += 30000;
  assert.ok(b.tryTake() > 0, "a block also empties the bucket");
  const polls = new TokenBucket(15, fakeClock());
  let n = 0;
  while (polls.tryTake() === 0) n += 1;
  assert.equal(n, 15);
});

test("outbox: replies before reminders before digests; a burst is coalesced; long text split at 4000", async () => {
  const clock = fakeClock();
  const sent: string[] = [];
  const box = new Outbox(async (t) => void sent.push(t), new ConnectionLimiter(clock));
  const all = [box.enqueue("digest", PRIORITY.digest), box.enqueue("reminder A", PRIORITY.reminder), box.enqueue("reminder B", PRIORITY.reminder), box.enqueue("reply", PRIORITY.reply)];
  await Promise.all(all);
  assert.deepEqual(sent, ["reply", "reminder A\n\nreminder B", "digest"]);
  sent.length = 0;
  const long = `${"word ".repeat(1500)}`.trim();
  await box.enqueue(long);
  assert.equal(sent.length, 2);
  assert.ok(sent.every((p) => p.length <= 4000));
});

test("outbox: 13 messages in a minute wait for the budget; 429 waits and retries; network retries 3 times; a rejected key fails the rest", async () => {
  const clock = fakeClock();
  const limiter = new ConnectionLimiter(clock);
  let calls = 0;
  const box = new Outbox(async () => void (calls += 1), limiter);
  for (let i = 0; i < 13; i += 1) await box.enqueue(`m${i}`);
  assert.equal(calls, 13);
  assert.ok(clock.slept.some((ms) => ms >= 4000), "the 13th waited for a token");

  let tries = 0;
  const flaky = new Outbox(async () => {
    tries += 1;
    if (tries === 1) throw new RateLimitedError(2000);
    if (tries <= 3) throw new NetworkError("No connection");
  }, new ConnectionLimiter(fakeClock()));
  assert.deepEqual(await flaky.enqueue("x"), { ok: true });
  assert.equal(tries, 4);

  const fatal: AgentError[] = [];
  const broken = new Outbox(async () => {
    throw new InvalidKeyError("Key rejected (HTTP 401)", 401);
  }, new ConnectionLimiter(fakeClock()), (e) => fatal.push(e));
  const [a, b] = await Promise.all([broken.enqueue("a", PRIORITY.reply), broken.enqueue("b", PRIORITY.digest)]);
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.equal(fatal.length, 1);
});

test("backoff: full jitter, at least 0.5 s, capped at a minute", () => {
  assert.equal(backoffMs(1, () => 0), 500);
  assert.equal(backoffMs(3, () => 0.999), 7992);
  assert.equal(backoffMs(20, () => 1), 60000);
});

test("context: oldest turns dropped first to fit the token cap; one long turn is cut", () => {
  const turns = [
    { role: "user" as const, content: "a".repeat(400) },
    { role: "assistant" as const, content: "b".repeat(400) },
    { role: "user" as const, content: "c".repeat(400) },
  ];
  assert.deepEqual(capTurns(turns, 200).map((t) => t.content[0]), ["b", "c"]);
  assert.equal(capTurns([{ role: "user", content: "x".repeat(5000) }], 100)[0].content.length, 400);
});

test("reminder message: one item gets its numbered options; a burst lists the rest", () => {
  const due = (title: string, id: string) => ({ key: id, logId: id, text: `Reminder: ${title}.`, actions: [{ label: "Done", payload: { type: "complete_task" as const, taskId: id } }, { label: "Snooze 15 min", payload: { type: "snooze_task" as const, taskId: id, minutes: 15 } }], taskId: id, occurrenceId: null, fireAt: new Date(), level: "normal", push: { title, body: "" } });
  assert.equal(composeReminder([due("Essay", "1")]).text, "Reminder: Essay.\n\n1. Done\n2. Snooze 15 min");
  const two = composeReminder([due("Essay", "1"), due("Quiz", "2")]);
  assert.match(two.text, /Also now:\n• Quiz\./);
  assert.match(two.text, /Options for "Essay":\n\n1\. Done/);
});

test("HTTP client against the fake API: updates, send, media as bytes or a URL, size cap; the key is never shown", async () => {
  const client = new HttpAgentClient(KEY, fake.base);
  assert.ok(!JSON.stringify(client).includes(KEY));
  assert.ok(!inspect(client, { depth: 5, showHidden: true }).includes(KEY));
  const id = fake.text(KEY, "hello");
  const got = await client.getUpdates({ offset: null, limit: 10, timeoutS: 0 });
  assert.equal(got.at(-1)?.id, String(id));
  assert.equal(got.at(-1)?.text, "hello");
  await client.getUpdates({ offset: nextOffset(String(id)), limit: 10, timeoutS: 0 }); // acknowledge
  await client.sendText("hi there", "chat-1");
  assert.deepEqual(fake.sent.at(-1)?.body, { chat_id: "chat-1", text: "hi there" });
  fake.media.set("bytes-1", { bytes: Buffer.from("OggS-voice"), type: "audio/ogg" });
  fake.media.set("url-1", { url: true, bytes: Buffer.from("%PDF-1.4"), type: "application/pdf" });
  assert.equal((await client.getMedia("bytes-1", 1000)).bytes.toString(), "OggS-voice");
  assert.equal((await client.getMedia("url-1", 1000)).bytes.toString(), "%PDF-1.4");
  await assert.rejects(client.getMedia("bytes-1", 4), MediaTooLargeError);
  await client.markRead("m1", "chat-1");
  assert.equal(fake.statuses.at(-1)?.status, "read");
  const bad = new HttpAgentClient(`${KEY}-revoked`, fake.base);
  await assert.rejects(bad.getUpdates({ offset: null, limit: 1, timeoutS: 0 }), (e: Error) => e instanceof InvalidKeyError && !e.message.includes(KEY));
});

/* ================================================================== database */

async function connected(key = KEY, over: Partial<UserSettings> = {}): Promise<{ user: User; settings: UserSettings; row: WhatsAppAgentConnection }> {
  const { user, settings } = await makeUser(over);
  const status = await connectAgent(user.id, key);
  responses.push(JSON.stringify(status));
  const row = await prisma.whatsAppAgentConnection.findUniqueOrThrow({ where: { userId: user.id } });
  return { user, settings, row };
}

function manager(handler?: (c: WhatsAppAgentConnection, u: AgentUpdate, io: HandlerIO) => Promise<void>): AgentConnectionManager {
  const m = new AgentConnectionManager({ lock: new PgAdvisoryLock(), handler: handler ?? ((c, u, io) => handleAgentUpdate(c, u, io)), pollTimeoutS: 1, rescanMs: 3600000 });
  managers.push(m);
  return m;
}

/** Drains whatever is queued for a key so tests start from a clean API. */
async function drain(key: string): Promise<void> {
  const c = new HttpAgentClient(key, fake.base);
  const list = await c.getUpdates({ offset: null, limit: 100, timeoutS: 0 });
  if (list.length) await c.getUpdates({ offset: nextOffset(list[list.length - 1].id), limit: 1, timeoutS: 0 });
}

test("connect: a wrong key is refused without echoing it; a good key is stored encrypted and history is skipped", { skip }, async () => {
  const { user } = await makeUser();
  await assert.rejects(connectAgent(user.id, "not-a-real-key-123"), (e: Error & { code?: string }) => e.message.includes("didn't accept") && !e.message.includes("not-a-real-key"));
  fake.code100Keys.add("code-100-key-xyz");
  await assert.rejects(connectAgent(user.id, "code-100-key-xyz"), (e: Error & { code?: string }) => e.code === "INVALID_KEY");
  await drain(KEY);
  const old = [fake.text(KEY, "sent before connecting 1"), fake.text(KEY, "sent before connecting 2")];
  const status = await connectAgent(user.id, KEY);
  responses.push(JSON.stringify(status));
  assert.equal(status.status, "CONNECTED");
  assert.equal(status.keyLast4, KEY.slice(-4));
  const row = await prisma.whatsAppAgentConnection.findUniqueOrThrow({ where: { userId: user.id } });
  assert.ok(!row.encryptedKey.includes(KEY));
  assert.equal(decryptSecret(row.encryptedKey, user.id), KEY);
  assert.equal(row.lastOffset, String(old[1] + 1), "starts after the newest update: nothing old is replayed");
  await disconnectAgent(user.id);
});

test("Pro only: Free users can't connect; a user back on Free stops being polled and gets a Pro notice", { skip }, async () => {
  const free = await makeUser({ tier: "FREE" });
  await assert.rejects(connectAgent(free.user.id, KEY), (e: Error & { code?: string }) => e.code === "PRO_REQUIRED");
  const freeStatus = await agentStatus(free.user.id);
  responses.push(JSON.stringify(freeStatus));
  assert.equal(freeStatus.pro, false);

  await drain(KEY);
  const { user, row } = await connected();
  const m = manager(async () => undefined);
  assert.equal(await m.add(row.id), true);
  await prisma.userSettings.update({ where: { userId: user.id }, data: { tier: "FREE" } });
  await m.rescan();
  assert.equal(m.isPolling(row.id), false);
  assert.equal(await m.add(row.id), false);
  const io = collectingIO();
  await handleAgentUpdate(row, update({ text: "what's due today" }), io);
  assert.equal(io.replies.at(-1), agentCopy("en").proOnly);
  assert.equal(await prisma.conversationMessage.count({ where: { userId: user.id } }), 0);
  await prisma.userSettings.update({ where: { userId: user.id }, data: { tier: "PRO" } });
  await m.rescan();
  assert.equal(m.isPolling(row.id), true, "polling resumes after upgrading");
  await m.stop();
  await disconnectAgent(user.id);
});

test("advisory lock: one holder per connection across sessions; released on unlock", { skip }, async () => {
  const a = new PgAdvisoryLock();
  const b = new PgAdvisoryLock();
  const id = randomUUID();
  try {
    assert.equal(await a.tryAcquire(id), true);
    assert.equal(await a.tryAcquire(id), true, "re-taking our own lock is fine");
    assert.equal(await a.held(id), true);
    assert.equal(await b.tryAcquire(id), false);
    assert.equal(await b.held(id), false);
    await a.release(id);
    assert.equal(await a.held(id), false);
    assert.equal(await b.tryAcquire(id), true);
  } finally {
    await b.release(id).catch(() => undefined);
    await a.close();
    await b.close();
  }
});

test("one poller per key: a second manager (another instance) does not poll the same connection, and takes over when the first stops", { skip }, async () => {
  await drain(KEY);
  const { user, row } = await connected();
  fake.maxConcurrentPolls = 0;
  const first = manager(async () => undefined);
  const second = manager(async () => undefined);
  assert.equal(await first.add(row.id), true);
  assert.equal(await second.add(row.id), false);
  assert.equal(await first.add(row.id), true, "adding again in the same instance starts nothing new");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(fake.maxConcurrentPolls, 1);
  await first.stop();
  await second.rescan();
  assert.equal(second.isPolling(row.id), true);
  await second.stop();
  await disconnectAgent(user.id);
});

test("dedupe, offset and crash recovery: a duplicated update is handled once; a restart neither repeats nor loses; an unfinished one gets 'resend'", { skip }, async () => {
  await drain(KEY);
  const { user, row } = await connected();
  const handled: string[] = [];
  const m1 = manager(async (_c, u) => void handled.push(u.text ?? ""));
  fake.duplicateNext = true;
  const a = fake.text(KEY, "one");
  const b = fake.text(KEY, "two");
  await m1.add(row.id);
  await waitFor(() => handled.length >= 2);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(handled, ["one", "two"]);
  await waitFor(async () => (await prisma.whatsAppAgentConnection.findUniqueOrThrow({ where: { id: row.id } })).lastOffset === String(b + 1));
  await m1.stop();

  // A crash between the claim and the end of handling: the row stays unfinished.
  await prisma.whatsAppProcessedUpdate.create({ data: { connectionId: row.id, updateId: "lost-1" } });
  const before = fake.sent.length;
  const m2 = manager(async (_c, u) => void handled.push(u.text ?? ""));
  await m2.add(row.id);
  await waitFor(() => fake.sent.length > before);
  assert.equal(fake.sent.at(-1)?.body.text, MISSED_REPLY);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(handled, ["one", "two"], "nothing handled twice after the restart");
  assert.ok(a < b);
  await m2.stop();
  await disconnectAgent(user.id);
});

test("invalid key while polling: NEEDS_RECONNECT, polling stops, the user gets a push; 429 waits and carries on", { skip }, async () => {
  const key = `WAKEY-${randomUUID()}-TEMP`;
  fake.validKeys.add(key);
  const { user, row } = await connected(key);
  const handled: string[] = [];
  const m = manager(async (_c, u) => void handled.push(u.text ?? ""));
  fake.rateLimitPolls = 1;
  fake.retryAfter = "1";
  await m.add(row.id);
  fake.text(key, "after the 429");
  await waitFor(() => handled.includes("after the 429"), 8000);
  await prisma.pushToken.create({ data: { token: `ExponentPushToken[${randomUUID()}]`, userId: user.id, platform: "android" } });
  const pushesBefore = pushes.length;
  fake.validKeys.delete(key); // the user regenerated the key in WhatsApp
  await waitFor(async () => (await prisma.whatsAppAgentConnection.findUniqueOrThrow({ where: { id: row.id } })).status === "NEEDS_RECONNECT", 8000);
  await waitFor(() => !m.isPolling(row.id));
  assert.ok(pushes.slice(pushesBefore).some((p) => p.title === "WhatsApp needs reconnecting" && (p.data as { type?: string }).type === "sync"));
  const status = await agentStatus(user.id);
  responses.push(JSON.stringify(status));
  assert.equal(status.connected, false);
  assert.match(status.lastError ?? "", /rejected/);
  await m.stop();
});

test("text end to end: fake API → poller → the one assistant engine → reply on WhatsApp, plus a read receipt", { skip }, async () => {
  await drain(KEY);
  const { user, row } = await connected();
  const m = manager();
  setAgentManager(m);
  await m.add(row.id);
  const before = fake.sent.length;
  fake.text(KEY, "Complete math assignment by Friday 3 PM");
  await waitFor(() => fake.sent.length > before, 15000);
  const reply = String(fake.sent.at(-1)?.body.text);
  assert.match(reply, /math assignment/i);
  const tasks = await prisma.task.findMany({ where: { userId: user.id } });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].source, "WHATSAPP");
  assert.ok(fake.statuses.length > 0);
  const conv = await prisma.conversation.findFirst({ where: { userId: user.id, channel: CHANNEL } });
  assert.ok(conv, "stored in the WHATSAPP_AGENT conversation, same engine as the app");
  await m.stop();
  setAgentManager(null);
  await disconnectAgent(user.id);
});

test("crisis first: crisis resources at once, nothing stored, the engine never runs", { skip }, async () => {
  const { user, row } = await connected();
  const io = collectingIO();
  await handleAgentUpdate(row, update({ text: "I want to kill myself" }), io);
  assert.deepEqual(io.replies, [crisisResponse("en")]);
  assert.equal(await prisma.conversationMessage.count({ where: { userId: user.id } }), 0);
  await disconnectAgent(user.id);
});

test("numbered replies: '1' answers the last reply's first option with its payload (same contract as the Twilio number)", { skip }, async () => {
  const { user, row } = await connected();
  const io = collectingIO();
  await handleAgentUpdate(row, update({ text: "help" }), io);
  assert.match(io.replies[0], /\n1\. .+\n2\. /);
  const before = await prisma.task.count({ where: { userId: user.id } });
  await handleAgentUpdate(row, update({ text: "1" }), io);
  assert.equal(await prisma.task.count({ where: { userId: user.id } }), before + 1, "option 1 of help is the create-task example");
  await disconnectAgent(user.id);
});

test("context window: after 30 quiet minutes the options and an open question expire; inside it they hold", { skip }, async () => {
  const { user, row } = await connected();
  const io = collectingIO();
  const now = new Date();
  await handleAgentUpdate(row, update({ text: "Study physics" }), io, now); // vague: the engine asks a question
  const fresh = await loadContext(user.id, CHANNEL, new Date(now.getTime() + 60000), { maxTurns: 8, ttlMs: 30 * 60000, maxTokens: 600 });
  assert.equal(fresh.expired, false);
  assert.ok(fresh.turns.length >= 2);
  const conv = await prisma.conversation.findFirstOrThrow({ where: { userId: user.id, channel: CHANNEL } });
  assert.ok((conv.state as { pending?: unknown }).pending, "the engine is waiting for an answer");
  const later = await loadContext(user.id, CHANNEL, new Date(now.getTime() + 31 * 60000), { maxTurns: 8, ttlMs: 30 * 60000, maxTokens: 600 });
  assert.equal(later.expired, true);
  assert.deepEqual(later.actions, []);
  assert.deepEqual(later.turns, []);
  assert.equal(await dropStaleQuestion(user.id, CHANNEL, later), true);
  const after = await prisma.conversation.findFirstOrThrow({ where: { id: conv.id } });
  assert.equal((after.state as { pending?: unknown }).pending, null);
  await disconnectAgent(user.id);
});

test("documents: the real pipeline reads a PDF, nothing is created until '1'; numbered add / review / ignore; size and type limits", { skip }, async () => {
  const { user, row } = await connected();
  const io = collectingIO();
  fake.media.set("doc-1", { bytes: textPdf(["CS101 Course Outline Fall 2026", "Assignment 1 due 30 November 2026 at 5 PM", "Quiz 2 on 5 December 2026"]), type: "application/pdf" });
  await handleAgentUpdate(row, update({ kind: "document", media: { id: "doc-1", mimeType: "application/pdf", size: null, duration: null, fileName: "outline.pdf" } }), io);
  const preview = io.replies.at(-1) ?? "";
  assert.match(preview, /I found \d+ items? with dates/);
  assert.match(preview, /1\. Add all\n2\. Review in app\n3\. Ignore/);
  assert.equal(await prisma.task.count({ where: { userId: user.id } }), 0, "WhatsApp documents never auto-create");
  await handleAgentUpdate(row, update({ text: "1" }), io);
  assert.match(io.replies.at(-1) ?? "", /^Added \d+ task/);
  const tasks = await prisma.task.findMany({ where: { userId: user.id } });
  assert.ok(tasks.length >= 1 && tasks.every((t) => t.source === "DOCUMENT"));

  // The preview expires after 10 minutes like any confirmation.
  fake.media.set("doc-2", { bytes: textPdf(["Lab report due 12 December 2026 at 9 AM"]), type: "application/pdf" });
  const t0 = new Date();
  await handleAgentUpdate(row, update({ kind: "document", media: { id: "doc-2", mimeType: "application/pdf", size: null, duration: null, fileName: null } }), io, t0);
  await handleAgentUpdate(row, update({ text: "1" }), io, new Date(t0.getTime() + 11 * 60000));
  assert.match(io.replies.at(-1) ?? "", /expired|again|older/i);

  await handleAgentUpdate(row, update({ kind: "document", media: { id: "x", mimeType: "application/zip", size: 10, duration: null, fileName: null } }), io);
  assert.equal(io.replies.at(-1), agentCopy("en").unsupported);
  await handleAgentUpdate(row, update({ kind: "document", media: { id: "x", mimeType: "application/pdf", size: 11 * 1024 * 1024, duration: null, fileName: null } }), io);
  assert.equal(io.replies.at(-1), agentCopy("en").tooBig);
  await disconnectAgent(user.id);
});

test("voice notes: on by default; no transcriber → please type; the user's switch; with a fake STT the reply starts with what was heard; low confidence asks to type; crisis in a transcript", { skip }, async () => {
  const { user, row } = await connected();
  const io = collectingIO();
  fake.media.set("voice-1", { bytes: Buffer.from("OggS fake audio"), type: "audio/ogg" });
  const voice = () => update({ kind: "voice", media: { id: "voice-1", mimeType: "audio/ogg", size: 15, duration: 3, fileName: null } });
  assert.equal((await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } })).waAgentVoice, true, "on by default");
  setStt(null);
  await handleAgentUpdate(row, voice(), io);
  assert.equal(io.replies.at(-1), agentCopy("en").voiceUnavailable, "no transcriber running: please type");
  await prisma.userSettings.update({ where: { userId: user.id }, data: { waAgentVoice: false } });
  await handleAgentUpdate(row, voice(), io);
  assert.equal(io.replies.at(-1), agentCopy("en").voiceOff);
  await prisma.userSettings.update({ where: { userId: user.id }, data: { waAgentVoice: true } });
  let next = { text: "Complete math assignment by Friday 3 PM", confidence: 0.9 as number | null };
  const stt: SttProvider = { name: "fake", dataLocation: "test", transcribe: async () => ({ ...next, language: "en", ms: 5 }) };
  setStt(stt);
  try {
    await handleAgentUpdate(row, voice(), io);
    assert.match(io.replies.at(-1) ?? "", /^I heard: "Complete math assignment by Friday 3 PM"\n\n/);
    assert.equal(await prisma.task.count({ where: { userId: user.id } }), 1);
    next = { text: "mmm", confidence: 0.2 };
    await handleAgentUpdate(row, voice(), io);
    assert.equal(io.replies.at(-1), agentCopy("en").typeIt);
    next = { text: "I want to kill myself", confidence: 0.95 };
    await handleAgentUpdate(row, voice(), io);
    assert.equal(io.replies.at(-1), crisisResponse("en"));
    await handleAgentUpdate(row, update({ kind: "voice", media: { id: "voice-1", mimeType: "audio/ogg", size: 15, duration: 600, fileName: null } }), io);
    assert.equal(io.replies.at(-1), agentCopy("en").voiceTooLong);
  } finally {
    setStt(undefined);
  }
  await disconnectAgent(user.id);
});

test("reminders: on by default (WhatsApp + phone), a server kill switch; sent on WhatsApp with numbered actions that reuse the push handlers; a failed send falls back to push", { skip }, async () => {
  await drain(KEY);
  const { user, row } = await connected(KEY, { quietStart: "00:00", quietEnd: "00:00" });
  const m = manager();
  await m.add(row.id);
  const now = new Date();
  const taskRow = await prisma.task.create({ data: { userId: user.id, title: "Submit essay", dueAt: new Date(now.getTime() + 2 * 3600000), dueDate: new Date(now.getTime() + 2 * 3600000), dueTime: "11:59 PM" } });
  const log = await prisma.reminderLog.create({ data: { userId: user.id, taskId: taskRow.id, fireAt: new Date(now.getTime() - 60000), level: "normal", status: "SCHEDULED" } });

  assert.equal((await agentStatus(user.id)).reminders.setting, "BOTH", "on by default, phone notifications too");
  assert.equal(await remindersViaAgent(user.id), false, "in BOTH the phone keeps its own notifications");
  process.env.WHATSAPP_AGENT_REMINDERS = "off";
  assert.equal(await sendDueAgentReminders(m, now), 0, "kill switch");
  await assert.rejects(updateAgentSettings(user.id, { reminders: "WHATSAPP" }), (e: Error & { code?: string }) => e.code === "REMINDERS_UNAVAILABLE");
  delete process.env.WHATSAPP_AGENT_REMINDERS;
  resetAgentReminderState();
  try {
    await updateAgentSettings(user.id, { reminders: "WHATSAPP" });
    assert.equal(await remindersViaAgent(user.id), true, "the phone leaves these reminders to WhatsApp");
    const before = fake.sent.length;
    assert.equal(await sendDueAgentReminders(m, now), 1);
    const text = String(fake.sent.at(-1)?.body.text);
    assert.ok(fake.sent.length > before);
    assert.match(text, /Reminder: Submit essay/);
    assert.match(text, /1\. Done\n2\. Snooze 15 min/);
    assert.equal((await prisma.reminderLog.findUniqueOrThrow({ where: { id: log.id } })).status, "SENT_WHATSAPP");
    assert.equal(await sendDueAgentReminders(m, now), 0, "never sent twice");

    // "2" on WhatsApp snoozes it through the same handler as the push button.
    const io = collectingIO();
    await handleAgentUpdate(row, update({ text: "2" }), io);
    assert.match(io.replies.at(-1) ?? "", /remind you about "Submit essay" again/);
    assert.equal(await prisma.reminderLog.count({ where: { taskId: taskRow.id, level: "SNOOZE", status: "SNOOZED" } }), 1);

    // A send WhatsApp refuses: the reminder goes out as a push instead, and the app is told why.
    await prisma.pushToken.create({ data: { token: `ExponentPushToken[${randomUUID()}]`, userId: user.id, platform: "android" } });
    const log2 = await prisma.reminderLog.create({ data: { userId: user.id, taskId: taskRow.id, fireAt: new Date(now.getTime() - 30000), level: "urgent", status: "SCHEDULED" } });
    fake.failSends = { count: 1, status: 400, code: 131047 };
    const pushesBefore = pushes.length;
    assert.equal(await sendDueAgentReminders(m, now), 0);
    assert.equal((await prisma.reminderLog.findUniqueOrThrow({ where: { id: log2.id } })).status, "SENT_PUSH");
    assert.ok(pushes.slice(pushesBefore).some((p) => p.title === "Submit essay"));
    assert.match((await agentStatus(user.id)).lastError ?? "", /phone notification/);
  } finally {
    await m.stop();
  }
  await disconnectAgent(user.id);
});

test("disconnect: the poller stops, the key is deleted, reminders go back to the phone", { skip }, async () => {
  await drain(KEY2);
  const { user, row } = await connected(KEY2);
  const m = manager();
  setAgentManager(m);
  await m.add(row.id);
  await prisma.userSettings.update({ where: { userId: user.id }, data: { waAgentReminders: "WHATSAPP" } });
  assert.equal(await remindersViaAgent(user.id), true);
  await disconnectAgent(user.id);
  assert.equal(m.isPolling(row.id), false);
  assert.equal(await prisma.whatsAppAgentConnection.count({ where: { userId: user.id } }), 0);
  assert.equal(await remindersViaAgent(user.id), false, "the phone schedules its reminders again");
  const status = await agentStatus(user.id);
  responses.push(JSON.stringify(status));
  assert.equal(status.status, null);
  await m.stop();
  setAgentManager(null);
});

/* ================================================================== the key never leaks (runs last) */

test("no API key anywhere: console output, API responses, the database in clear", async () => {
  for (const k of [KEY, KEY2]) {
    assert.ok(!captured.some((line) => line.includes(k)), "a key reached the console");
    assert.ok(!responses.some((r) => r.includes(k)), "a key reached an API response");
  }
  if (!dbAvailable) return;
  const tables = ["WhatsAppAgentConnection", "WhatsAppProcessedUpdate", "ConversationMessage", "Conversation", "ActivityEvent", "UserSettings", "ReminderLog"];
  for (const t of tables) {
    const rows = await prisma.$queryRawUnsafe<Array<{ j: string }>>(`SELECT row_to_json(x)::text AS j FROM "${t}" x`);
    for (const k of [KEY, KEY2]) assert.ok(!rows.some((r) => r.j.includes(k)), `a key is stored in clear in ${t}`);
  }
});

