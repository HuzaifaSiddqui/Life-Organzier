import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Priority, TaskSource, TaskStatus, TaskType, type UserSettings } from "@prisma/client";
import { AiService, ProviderHttpError, setAi, type ChatMessage, type CompletionOptions, type LlmProvider } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import { clampTapTime, expireCheckins, researchIncludesStep, planCheckins, queueFirstStepRetry, remainingMinutes, respondToCheckin, responseAllowed } from "../src/modules/checkins/checkinService.js";
import { parseCheckinStyle } from "../src/modules/checkins/style.js";
import { templateCopy } from "../src/modules/checkins/copy.js";
import { understand } from "../src/modules/assistant/nlu.js";
import { handleAssistantMessage } from "../src/modules/assistant/dialogue.js";
import { createTask, updateTask } from "../src/modules/tasks/taskService.js";
import { dbAvailable, opts } from "./fixtures.js";

class Mock implements LlmProvider {
  calls: number[] = [];
  constructor(
    readonly name: string,
    private readonly behaviour: () => unknown,
    readonly minIntervalMs = 0,
  ) {}
  async chat(_m: ChatMessage[], _o: CompletionOptions): Promise<string> {
    this.calls.push(Date.now());
    const r = this.behaviour();
    if (r instanceof Error) throw r;
    return JSON.stringify(r);
  }
}

/* ------------------------------------------------------------------ AI layer */

test("AI breaker: 429 cools down for 10 min, 503 and timeouts for 30 s; status reports the error type", async () => {
  for (const [error, type, minMs] of [
    [new ProviderHttpError(429, "Gemini API error (HTTP 429)"), "rate_limit", 9 * 60000],
    [new ProviderHttpError(503, "Gemini API error (HTTP 503)"), "unavailable", 29000],
    [Object.assign(new Error("This operation was aborted"), { name: "AbortError" }), "timeout", 29000],
    [new ProviderHttpError(404, "Gemini API error (HTTP 404)"), "not_found", 29000],
  ] as const) {
    const ai = new AiService([new Mock("gemini", () => error)]);
    assert.equal(await ai.complete([{ role: "user", content: "x" }], { providers: ["gemini"] }), null);
    const s = ai.providerStatus("gemini");
    assert.equal(s.available, false);
    assert.equal(s.lastError?.type, type);
    const until = (ai as unknown as { registry: Map<string, { downUntil: number }> }).registry.get("gemini")!.downUntil;
    assert.ok(until - Date.now() >= minMs && until - Date.now() <= (type === "rate_limit" ? 600000 : 30000) + 50, `${type}: ${until - Date.now()} ms`);
  }
  assert.deepEqual(new AiService([]).providerStatus("gemini"), { configured: false, model: null, available: false, lastError: null });
});

test("AI pacing: background calls to a paced provider keep the minimum interval", async () => {
  const gemini = new Mock("gemini", () => ({ firstStep: "Open the notes" }), 120);
  const ai = new AiService([gemini]);
  await Promise.all([1, 2, 3].map(() => ai.complete([{ role: "user", content: "x" }], { providers: ["gemini"], background: true })));
  assert.equal(gemini.calls.length, 3);
  for (let i = 1; i < 3; i += 1) assert.ok(gemini.calls[i] - gemini.calls[i - 1] >= 115, `gap ${gemini.calls[i] - gemini.calls[i - 1]} ms`);
});

/* ------------------------------------------------------------------ style intent */

test("style: English and Roman Urdu requests map to the right style", () => {
  const cases: Array<[string, ReturnType<typeof parseCheckinStyle>]> = [
    ["be more serious with reminders", { kind: "tone", tone: "SERIOUS" }],
    ["change your tone to gentle", { kind: "tone", tone: "GENTLE" }],
    ["stop joking", { kind: "tone", tone: "SERIOUS" }],
    ["serious ho jao", { kind: "tone", tone: "SERIOUS" }],
    ["mazaq band karo", { kind: "tone", tone: "SERIOUS" }],
    ["narmi se baat karo", { kind: "tone", tone: "GENTLE" }],
    ["make reminders funny again", { kind: "tone", tone: "FUNNY" }],
    ["Turn off check-ins", { kind: "off" }],
    ["check-ins band karo", { kind: "off" }],
    ["turn check-ins back on", { kind: "on" }],
    ["change your style", { kind: "ask" }],
    ["I need to be serious about my exams", null],
    ["Remind me to call Ali tomorrow", null],
    ["this joke app is great", null],
  ];
  for (const [text, expected] of cases) assert.deepEqual(parseCheckinStyle(text), expected, text);
});

test("style: the NLU routes style requests by rules, before task creation", async () => {
  setAi(new AiService([]));
  for (const text of ["be more serious with reminders", "mazaq band karo", "Turn off check-ins"]) {
    const u = await understand(text, { ...opts, history: [], allowLlm: false });
    assert.equal(u.intent, "set_checkin_style", text);
    assert.equal(u.source, "rules");
  }
});

test("respond: allowed answers per kind; remaining time after a partial", () => {
  assert.equal(responseAllowed("START", "STARTED"), true);
  assert.equal(responseAllowed("START_FOLLOWUP", "NOT_TODAY"), true);
  assert.equal(responseAllowed("START", "DONE"), false);
  assert.equal(responseAllowed("COMPLETION", "PLUS_30"), true);
  assert.equal(responseAllowed("COMPLETION_EXTRA", "PARTIAL_50"), true);
  assert.equal(responseAllowed("COMPLETION", "STARTED"), false);
  assert.equal(remainingMinutes(120, 50), 60);
  assert.equal(remainingMinutes(30, 75), 15);
});

/* ------------------------------------------------------------------ DB-backed flow */

const minute = (d: Date) => new Date(Math.floor(d.getTime() / 60000) * 60000);

async function withUser(fn: (ctx: { userId: string; tz: string }, settings: UserSettings) => Promise<void>, overrides: Partial<UserSettings> = {}) {
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  // Quiet hours 00:00–00:00 = none, so the test passes at any time of day.
  const settings = await prisma.userSettings.create({ data: { userId: user.id, timezone: "Asia/Karachi", quietStart: "00:00", quietEnd: "00:00", ...overrides } });
  try {
    await fn({ userId: user.id, tz: settings.timezone }, settings);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
}

const skip = !dbAvailable && "no database";

test("plan: rows are persisted with stable ids and the old slot's check-ins are cancelled on reschedule", { skip }, async () => {
  setAi(new AiService([]));
  await withUser(async (ctx, settings) => {
    const start = minute(new Date(Date.now() + 2 * 3600000));
    const t = await createTask(ctx, { title: "Physics assignment", priority: Priority.MEDIUM, source: TaskSource.CHAT, taskType: TaskType.FLEXIBLE, durationMinutes: 120, scheduledStart: start, scheduledEnd: new Date(start.getTime() + 7200000) });
    const first = await planCheckins(ctx.userId, settings);
    assert.deepEqual(first.map((c) => c.kind), ["START", "START_FOLLOWUP", "COMPLETION"]);
    assert.equal(first[0].category, "START");
    assert.equal(first[2].category, "COMPLETION");
    assert.match(first[0].body, /Physics assignment/);
    assert.equal(first[0].tone, "FUNNY", "new users get Funny");
    const again = await planCheckins(ctx.userId, settings);
    assert.deepEqual(again.map((c) => c.id), first.map((c) => c.id), "ids stay stable across re-plans");

    const moved = new Date(start.getTime() + 86400000);
    await updateTask(ctx, t.id, { scheduledStart: moved, scheduledEnd: new Date(moved.getTime() + 7200000) });
    const old = await prisma.checkinLog.findMany({ where: { id: { in: first.map((c) => c.id) } } });
    assert.ok(old.every((r) => r.status === "CANCELLED"));
    const next = await planCheckins(ctx.userId, settings);
    assert.equal(next.length, 3);
    assert.ok(next.every((c) => !first.some((f) => f.id === c.id)));
  });
});

test("plan: a hard mood in the last 24 h makes the check-in Gentle with a split offer; saved style stays Funny", { skip }, async () => {
  setAi(new AiService([]));
  await withUser(async (ctx, settings) => {
    const start = minute(new Date(Date.now() + 2 * 3600000));
    await createTask(ctx, { title: "Physics assignment", priority: Priority.MEDIUM, source: TaskSource.CHAT, taskType: TaskType.FLEXIBLE, durationMinutes: 120, scheduledStart: start });
    await prisma.moodLog.create({ data: { userId: ctx.userId, mood: "overwhelmed", source: "MANUAL", createdAt: new Date(Date.now() - 3 * 3600000) } });
    const plan = await planCheckins(ctx.userId, settings);
    assert.ok(plan.every((c) => c.tone === "GENTLE" && c.offerSplit));
    assert.equal((await prisma.userSettings.findUnique({ where: { userId: ctx.userId } }))?.checkinTone, "FUNNY");
  });
});

test("respond: Started → IN_PROGRESS + startedAt + the completion check-in to schedule", { skip }, async () => {
  setAi(new AiService([]));
  await withUser(async (ctx, settings) => {
    const start = minute(new Date(Date.now() - 2 * 60000));
    const t = await createTask(ctx, { title: "Physics assignment", priority: Priority.MEDIUM, source: TaskSource.CHAT, taskType: TaskType.FLEXIBLE, durationMinutes: 120, scheduledStart: start });
    const row = await prisma.checkinLog.create({ data: { userId: ctx.userId, taskId: t.id, slotStart: start, kind: "START", fireAt: new Date(start.getTime() + 5 * 60000), tone: "FUNNY", copySource: "LIBRARY", message: "Started?" } });
    const r = await respondToCheckin(ctx.userId, settings, ctx, row.id, "STARTED");
    assert.equal(r.task?.status, TaskStatus.IN_PROGRESS);
    assert.ok(r.task?.startedAt);
    assert.equal(r.next?.kind, "COMPLETION");
    const expected = new Date(r.task!.startedAt!).getTime() + (120 + 12) * 60000;
    assert.ok(Math.abs(new Date(r.next!.fireAt).getTime() - expected) < 1000, "startedAt + duration + 10 %");
    // A second tap (or a late offline duplicate) changes nothing.
    const dup = await respondToCheckin(ctx.userId, settings, ctx, row.id, "STARTED");
    assert.equal(dup.alreadyAnswered, true);
    await assert.rejects(respondToCheckin(ctx.userId, settings, ctx, randomUUID(), "STARTED"), /not found/i);
  });
});

test("respond: Done, partly done, +30 within and past the deadline, refused after two extras", { skip }, async () => {
  setAi(new AiService([]));
  await withUser(async (ctx, settings) => {
    const start = minute(new Date(Date.now() - 2 * 3600000));
    const make = (o: Record<string, unknown> = {}) =>
      createTask(ctx, { title: "Physics assignment", priority: Priority.MEDIUM, source: TaskSource.CHAT, taskType: TaskType.FLEXIBLE, durationMinutes: 120, scheduledStart: start, ...o });
    const completion = (taskId: string, kind = "COMPLETION", offset = 0) =>
      prisma.checkinLog.create({ data: { userId: ctx.userId, taskId, slotStart: start, kind, fireAt: new Date(Date.now() - 60000 - offset), tone: "FUNNY", copySource: "NONE", message: "Done?" } });

    const a = await make();
    const done = await respondToCheckin(ctx.userId, settings, ctx, (await completion(a.id)).id, "DONE");
    assert.equal(done.task?.status, TaskStatus.COMPLETED);
    assert.ok(done.task?.completedAt);
    assert.match(done.message ?? "", /Physics assignment/);

    const b = await make();
    const partly = await respondToCheckin(ctx.userId, settings, ctx, (await completion(b.id)).id, "PARTIAL_50");
    assert.equal(partly.task?.progress, 50);
    assert.equal(partly.remainingMinutes, 60);
    assert.match(partly.message ?? "", /50%/);

    const c = await make({ dueAt: undefined, dueDate: null });
    const plus = await respondToCheckin(ctx.userId, settings, ctx, (await completion(c.id)).id, "PLUS_30");
    assert.equal(plus.next?.kind, "COMPLETION_EXTRA");
    assert.equal(plus.deadlineWarning, false);

    const due = new Date(Date.now() + 10 * 60000);
    const d = await make({ dueDate: due, dueTime: null });
    await prisma.task.update({ where: { id: d.id }, data: { dueAt: due } });
    const late = await respondToCheckin(ctx.userId, settings, ctx, (await completion(d.id)).id, "PLUS_30");
    assert.equal(late.deadlineWarning, true);
    assert.match(late.message ?? "", /past/);

    // Two extras already used for this slot → refused with a message, never silently.
    const e = await make();
    for (const i of [1, 2]) await completion(e.id, "COMPLETION_EXTRA", i * 1000);
    const refused = await respondToCheckin(ctx.userId, settings, ctx, (await completion(e.id)).id, "PLUS_30");
    assert.equal(refused.refused, "limit");
    assert.equal(refused.next, null);
    assert.ok(refused.message && refused.message.length > 10);
  });
});

test("respond: Urdu users get Urdu replies", { skip }, async () => {
  setAi(new AiService([]));
  await withUser(
    async (ctx, settings) => {
      const start = minute(new Date(Date.now() - 2 * 3600000));
      const t = await createTask(ctx, { title: "Physics assignment", priority: Priority.MEDIUM, source: TaskSource.CHAT, taskType: TaskType.FLEXIBLE, durationMinutes: 120, scheduledStart: start });
      const row = await prisma.checkinLog.create({ data: { userId: ctx.userId, taskId: t.id, slotStart: start, kind: "COMPLETION", fireAt: new Date(Date.now() - 60000), tone: "FUNNY", copySource: "NONE", message: "x" } });
      const r = await respondToCheckin(ctx.userId, settings, ctx, row.id, "DIDNT");
      assert.match(r.message ?? "", /[؀-ۿ]/);
    },
    { language: "ur" },
  );
});

test("maintenance: unanswered check-ins older than 2 h become IGNORED", { skip }, async () => {
  await withUser(async (ctx) => {
    const t = await createTask(ctx, { title: "Essay", priority: Priority.MEDIUM, source: TaskSource.MANUAL });
    const old = await prisma.checkinLog.create({ data: { userId: ctx.userId, taskId: t.id, slotStart: new Date(), kind: "START", fireAt: new Date(Date.now() - 3 * 3600000), tone: "FUNNY", copySource: "NONE", message: "x" } });
    const recent = await prisma.checkinLog.create({ data: { userId: ctx.userId, taskId: t.id, slotStart: new Date(), kind: "START_FOLLOWUP", fireAt: new Date(Date.now() - 60000), tone: "FUNNY", copySource: "NONE", message: "x" } });
    await expireCheckins();
    assert.equal((await prisma.checkinLog.findUnique({ where: { id: old.id } }))?.status, "IGNORED");
    assert.equal((await prisma.checkinLog.findUnique({ where: { id: recent.id } }))?.status, "SCHEDULED");
  });
});

test("retry: Gemini is retried for library steps only when the start is > 30 min away, max 2 per slot", { skip }, async () => {
  const gemini = new Mock("gemini", () => ({ firstStep: "Open the problem set" }));
  setAi(new AiService([gemini]));
  await withUser(async (ctx, settings) => {
    const soon = minute(new Date(Date.now() + 20 * 60000));
    const t = await createTask(ctx, { title: "Physics assignment", priority: Priority.MEDIUM, source: TaskSource.MANUAL, taskType: TaskType.FLEXIBLE, durationMinutes: 60 });
    const withCopy = async (start: Date, retries = 0) => {
      const copy = { ...templateCopy({ ...t, scheduledStart: start }, settings), retries };
      return prisma.task.update({ where: { id: t.id }, data: { scheduledStart: start, checkinCopy: copy } });
    };
    assert.equal(queueFirstStepRetry(await withCopy(soon), settings), false, "start within 30 min");
    const later = minute(new Date(Date.now() + 3 * 3600000));
    assert.equal(queueFirstStepRetry(await withCopy(later, 2), settings), false, "retries used up");
    assert.equal(queueFirstStepRetry(await withCopy(later, 0), settings), true);
    for (let i = 0; i < 50; i += 1) {
      const c = (await prisma.task.findUnique({ where: { id: t.id } }))?.checkinCopy as { firstStepSource?: string; retries?: number } | null;
      if (c?.firstStepSource === "GEMINI") {
        assert.equal(c.retries, 1);
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail("retry result was not saved");
  });
});

test("chat: style requests update the setting and confirm with chips for the other styles", { skip }, async () => {
  setAi(new AiService([]));
  await withUser(async (_ctx, settings) => {
    const user = (await prisma.user.findUnique({ where: { id: settings.userId } }))!;
    const say = async (text: string) => {
      const s = (await prisma.userSettings.findUnique({ where: { userId: user.id } }))!;
      return handleAssistantMessage({ user, settings: s, deviceId: null, text, channel: "APP" });
    };
    let r = await say("be more serious with reminders");
    assert.equal(r.message.intent, "checkin_style_set");
    assert.match(r.message.content, /serious/);
    assert.deepEqual(r.message.actions?.map((a) => a.label), ["Funny", "Gentle"]);
    assert.equal((await prisma.userSettings.findUnique({ where: { userId: user.id } }))?.checkinTone, "SERIOUS");
    r = await say("narmi se baat karo");
    assert.equal((await prisma.userSettings.findUnique({ where: { userId: user.id } }))?.checkinTone, "GENTLE");
    r = await say("Turn off check-ins");
    assert.equal(r.message.intent, "checkins_off");
    assert.equal((await prisma.userSettings.findUnique({ where: { userId: user.id } }))?.checkinsEnabled, false);
  });
});

test("respond: tap time is clamped to [fireAt, now]", () => {
  const fire = new Date("2026-10-09T11:05:00Z");
  const now = new Date("2026-10-09T13:00:00Z");
  assert.equal(clampTapTime(null, fire, now).getTime(), now.getTime());
  assert.equal(clampTapTime(new Date("2026-10-09T11:07:00Z"), fire, now).toISOString(), "2026-10-09T11:07:00.000Z");
  assert.equal(clampTapTime(new Date("2026-10-09T10:00:00Z"), fire, now).getTime(), fire.getTime(), "before it fired");
  assert.equal(clampTapTime(new Date("2026-10-10T00:00:00Z"), fire, now).getTime(), now.getTime(), "in the future");
});

const startRow = (userId: string, taskId: string, start: Date, o: Record<string, unknown> = {}) =>
  prisma.checkinLog.create({ data: { userId, taskId, slotStart: start, kind: "START", fireAt: new Date(start.getTime() + 5 * 60000), tone: "FUNNY", copySource: "LIBRARY", message: "Started?", ...o } });

test("respond: answering an old check-in for a task already completed in the app changes nothing", { skip }, async () => {
  setAi(new AiService([]));
  await withUser(async (ctx, settings) => {
    const start = minute(new Date(Date.now() - 30 * 60000));
    const t = await createTask(ctx, { title: "Physics assignment", priority: Priority.MEDIUM, source: TaskSource.CHAT, taskType: TaskType.FLEXIBLE, durationMinutes: 120, scheduledStart: start });
    const row = await startRow(ctx.userId, t.id, start);
    await updateTask(ctx, t.id, { status: TaskStatus.COMPLETED });
    const r = await respondToCheckin(ctx.userId, settings, ctx, row.id, "STARTED");
    assert.equal(r.task?.status, TaskStatus.COMPLETED);
    assert.equal(r.next, null);
    assert.equal(r.message, "Already done ✓");
    assert.equal((await prisma.checkinLog.findUnique({ where: { id: row.id } }))?.response, "STARTED", "the answer is still recorded");
  });
});

test("respond: answering a cancelled (rescheduled) check-in changes nothing", { skip }, async () => {
  setAi(new AiService([]));
  await withUser(async (ctx, settings) => {
    const start = minute(new Date(Date.now() - 30 * 60000));
    const t = await createTask(ctx, { title: "Physics assignment", priority: Priority.MEDIUM, source: TaskSource.CHAT, taskType: TaskType.FLEXIBLE, durationMinutes: 120, scheduledStart: start });
    const row = await startRow(ctx.userId, t.id, start, { status: "CANCELLED" });
    const r = await respondToCheckin(ctx.userId, settings, ctx, row.id, "STARTED");
    assert.equal(r.task?.status, TaskStatus.PENDING);
    assert.equal(r.next, null);
    assert.match(r.message ?? "", /no longer current/);
  });
});

test("respond: DONE on a cancelled check-in still completes the task", { skip }, async () => {
  setAi(new AiService([]));
  await withUser(async (ctx, settings) => {
    const start = minute(new Date(Date.now() - 3 * 3600000));
    const t = await createTask(ctx, { title: "Physics assignment", priority: Priority.MEDIUM, source: TaskSource.CHAT, taskType: TaskType.FLEXIBLE, durationMinutes: 120, scheduledStart: start });
    const row = await prisma.checkinLog.create({ data: { userId: ctx.userId, taskId: t.id, slotStart: start, kind: "COMPLETION", fireAt: new Date(Date.now() - 60000), tone: "FUNNY", copySource: "NONE", message: "Done?", status: "CANCELLED" } });
    const r = await respondToCheckin(ctx.userId, settings, ctx, row.id, "DONE");
    assert.equal(r.task?.status, TaskStatus.COMPLETED);
    assert.equal(r.next, null);
  });
});

test("respond: two concurrent +30 answers create exactly one extra check-in", { skip }, async () => {
  setAi(new AiService([]));
  await withUser(async (ctx, settings) => {
    const start = minute(new Date(Date.now() - 2 * 3600000));
    const t = await createTask(ctx, { title: "Physics assignment", priority: Priority.MEDIUM, source: TaskSource.CHAT, taskType: TaskType.FLEXIBLE, durationMinutes: 120, scheduledStart: start });
    const row = await prisma.checkinLog.create({ data: { userId: ctx.userId, taskId: t.id, slotStart: start, kind: "COMPLETION", fireAt: new Date(Date.now() - 60000), tone: "FUNNY", copySource: "NONE", message: "Done?" } });
    const [a, b] = await Promise.all([respondToCheckin(ctx.userId, settings, ctx, row.id, "PLUS_30"), respondToCheckin(ctx.userId, settings, ctx, row.id, "PLUS_30")]);
    assert.deepEqual([a.alreadyAnswered, b.alreadyAnswered].sort(), [false, true]);
    assert.equal(await prisma.checkinLog.count({ where: { taskId: t.id, kind: "COMPLETION_EXTRA" } }), 1);
  });
});

test("respond: a STARTED delivered late uses the tap time for startedAt and the completion check-in", { skip }, async () => {
  setAi(new AiService([]));
  await withUser(async (ctx, settings) => {
    const start = minute(new Date(Date.now() - 50 * 60000));
    const t = await createTask(ctx, { title: "Physics assignment", priority: Priority.MEDIUM, source: TaskSource.CHAT, taskType: TaskType.FLEXIBLE, durationMinutes: 120, scheduledStart: start });
    const row = await startRow(ctx.userId, t.id, start);
    const tapped = new Date(start.getTime() + 7 * 60000); // tapped offline 43 min ago
    const r = await respondToCheckin(ctx.userId, settings, ctx, row.id, "STARTED", new Date(), tapped);
    assert.equal(new Date(r.task!.startedAt!).getTime(), tapped.getTime());
    assert.equal(new Date(r.next!.fireAt).getTime(), tapped.getTime() + (120 + 12) * 60000);
    assert.equal((await prisma.checkinLog.findUnique({ where: { id: row.id } }))?.respondedAt?.getTime(), tapped.getTime());
    // One versioned write (sync-safe): the version goes up exactly once and history records it.
    assert.equal(r.task?.version, t.version + 1);
    assert.equal(await prisma.taskVersion.count({ where: { taskId: t.id } }), 2);
  });
});

test("plan: research mode records WITHHELD when it omits an existing first step", { skip }, async () => {
  setAi(new AiService([]));
  await withUser(
    async (ctx, settings) => {
      // One task per day (stays under the daily cap); pick start minutes so both variants occur.
      const base = minute(new Date(Date.now() + 26 * 3600000));
      const wanted = [true, false, true, false];
      for (const [day, include] of wanted.entries()) {
        let start = new Date(base.getTime() + day * 86400000);
        const t = await createTask(ctx, { title: `Physics assignment ${day}`, priority: Priority.MEDIUM, source: TaskSource.CHAT, taskType: TaskType.FLEXIBLE, durationMinutes: 60, scheduledStart: start });
        for (let m = 0; m < 120 && researchIncludesStep(`${t.id}:START:${new Date(start.getTime() + 5 * 60000).toISOString()}`) !== include; m += 1) {
          start = new Date(start.getTime() + 60000);
        }
        await prisma.task.update({ where: { id: t.id }, data: { scheduledStart: start } });
      }
      await planCheckins(ctx.userId, settings);
      const rows = await prisma.checkinLog.findMany({ where: { userId: ctx.userId, kind: { in: ["START", "START_FOLLOWUP"] } } });
      for (const r of rows) {
        const shown = researchIncludesStep(`${r.taskId}:${r.kind}:${r.fireAt.toISOString()}`);
        assert.equal(r.copySource, shown ? "LIBRARY" : "WITHHELD", `${r.kind} ${r.fireAt.toISOString()}`);
        assert.equal(r.hasFirstStep, shown);
      }
      const starts = rows.filter((r) => r.kind === "START");
      assert.ok(starts.some((r) => r.copySource === "WITHHELD"), "some withheld");
      assert.ok(starts.some((r) => r.copySource === "LIBRARY"), "some shown");
    },
    { checkinResearchMode: true },
  );
});

test("chat: choosing a style while check-ins are off turns them back on and says so", { skip }, async () => {
  setAi(new AiService([]));
  await withUser(
    async (_ctx, settings) => {
      const user = (await prisma.user.findUnique({ where: { id: settings.userId } }))!;
      const r = await handleAssistantMessage({ user, settings, deviceId: null, text: "be more serious with reminders", channel: "APP" });
      assert.match(r.message.content, /back on/);
      assert.equal((await prisma.userSettings.findUnique({ where: { userId: user.id } }))?.checkinsEnabled, true);
    },
    { checkinsEnabled: false },
  );
});

test.after(() => prisma.$disconnect());
