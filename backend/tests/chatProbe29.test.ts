import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { AiService, setAi } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import { dueDateFromYmd } from "../src/lib/time.js";
import "../src/modules/assistant/commands/registry.js";
import { handleAssistantMessage } from "../src/modules/assistant/dialogue.js";
import { requestConnection, respondConnection } from "../src/modules/collab/collabService.js";
import { addMessage } from "../src/modules/conversations/conversationService.js";
import { createRoutine } from "../src/modules/routines/routineService.js";
import { createTask } from "../src/modules/tasks/taskService.js";
import { dbAvailable } from "./fixtures.js";

/**
 * The 29-message chat probe (tests/eval/chat-probe-29.json) on the rules path: AI off, CHAT_FIXES_V2 + OOS_NOTE +
 * COLLAB_TASKS on, a throwaway seeded user per conversation. Checks the fixes of PR A; PROBE_OUT=<file> also writes
 * every reply as JSON (for before/after reports).
 */
type Turn = { say: string; assistantBefore?: string };
type Seed = { now: string; timezone: string; tasks: Array<{ title: string; due?: string; status?: string; completedAt?: string }>; routines: Array<{ title: string; days: string; time: string }>; connections: string[] };
const set = JSON.parse(readFileSync(new URL("./eval/chat-probe-29.json", import.meta.url), "utf8")) as { seed: Seed; conversations: Array<{ id: string; turns: Turn[] }> };
const NOW = new Date(set.seed.now);
const TZ = set.seed.timezone;
const DAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const clock12 = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

type Reply = { conv: string; say: string; intent: string; content: string; titles: string[] };

async function seedUser(created: string[]) {
  const tag = randomUUID().slice(0, 8);
  const mk = async (name: string) => {
    const u = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `probe-${name}-${tag}@example.test`, username: `${name}_${tag}`.slice(0, 20), displayName: name } });
    created.push(u.id);
    await prisma.userSettings.create({ data: { userId: u.id, timezone: TZ, tier: "PRO" } });
    return u;
  };
  const me = await mk("probe");
  for (const t of set.seed.tasks) {
    const [ymd, hm] = (t.due ?? "").split(" ");
    const task = await createTask({ userId: me.id, tz: TZ, deviceId: null }, { title: t.title, priority: "MEDIUM", source: "MANUAL", ...(ymd ? { dueDate: dueDateFromYmd(ymd, TZ), dueTime: hm ? clock12(hm) : null } : {}) } as never);
    if (t.status === "completed") await prisma.task.update({ where: { id: task.id }, data: { status: "COMPLETED", progress: 100, completedAt: new Date(t.completedAt!) } });
  }
  for (const r of set.seed.routines) {
    const daily = r.days === "daily";
    await createRoutine(me.id, TZ, { title: r.title, frequency: daily ? "DAILY" : "WEEKLY", daysOfWeek: daily ? null : r.days.split(",").map((d) => DAY[d]), dueTime: clock12(r.time) } as never, NOW);
  }
  for (const name of set.seed.connections) {
    const other = await mk(name);
    await respondConnection(other, (await requestConnection(me, other.id)).connectionId, true);
  }
  return me;
}

test("chat probe (29 messages), rules path: the PR A fixes hold", { skip: !dbAvailable && "no database" }, async () => {
  setAi(new AiService([]));
  const flags = ["CHAT_FIXES_V2", "OOS_NOTE", "COLLAB_TASKS"] as const;
  const keep = flags.map((f) => process.env[f]);
  for (const f of flags) process.env[f] = "on";
  const created: string[] = [];
  const replies: Reply[] = [];
  try {
    for (const conv of set.conversations) {
      const me = await seedUser(created);
      const settings = await prisma.userSettings.findUniqueOrThrow({ where: { userId: me.id } });
      const conversation = await prisma.conversation.create({ data: { userId: me.id, channel: "APP", title: `probe ${conv.id}` } });
      for (const [i, t] of conv.turns.entries()) {
        if (t.assistantBefore) await addMessage({ conversationId: conversation.id, userId: me.id, role: "ASSISTANT", content: t.assistantBefore } as never);
        const m = (await handleAssistantMessage({ user: me, settings, deviceId: null, text: t.say, channel: "APP", conversationId: conversation.id, now: new Date(NOW.getTime() + i * 60000) } as never)).message;
        const titles = (await prisma.task.findMany({ where: { userId: me.id, status: { not: "DELETED" } }, select: { title: true } })).map((x) => x.title);
        replies.push({ conv: conv.id, say: t.say, intent: m.intent ?? "", content: m.content, titles });
      }
    }
    if (process.env.PROBE_OUT) writeFileSync(process.env.PROBE_OUT, JSON.stringify(replies, null, 1));
    const at = (say: string) => replies.find((r) => r.say === say)!;
    // A4: a correction answers what was asked, never searches for "not asking about".
    assert.doesNotMatch(at("I am not asking about task, I am asking about my completed task.").content, /not asking/i);
    // A3: "add Sana to the above task" is not a new task; sharing an existing task is explained.
    const share = at("add Sana to the above task");
    assert.equal(share.intent, "share_existing");
    assert.ok(!share.titles.some((x) => /sana/i.test(x)), "no task called 'Add Sana…'");
    // A3: "complete the second one" completes a listed task, never adds "Complete the second one".
    const second = at("complete the second one");
    assert.notEqual(second.intent, "clarify");
    assert.ok(!second.titles.some((x) => /second one/i.test(x)));
    // A1: app questions get the fixed answers.
    assert.equal(at("is my data private?").intent, "app_privacy");
    assert.equal(at("who made you?").intent, "app_identity");
    // A2 + OOS_NOTE: the alarm is a new request (not an answer to the cab question), with the honest note.
    const alarm = at("set an alarm for 6 am");
    assert.match(alarm.content, /^I can't set phone alarms, but I'll keep it as a reminder\./);
    assert.match(alarm.content, /I've left "Book me a cab to the airport" unfinished\.\)$/);
    // A2 + A3: "update the report" asks which of the two reports.
    const report = at("update the report");
    assert.equal(report.intent, "choose_task");
    assert.ok(!report.titles.some((x) => /^update the report$/i.test(x)));
    // A4: "no, the other one" never offers to add a task.
    const other = at("no, the other one");
    assert.ok(!["unknown", "task_created", "clarify"].includes(other.intent), other.intent);
    assert.equal(at("never mind").intent, "cancel", "cancels the open question");
    // Nothing anywhere became a junk task named after a command.
    for (const r of replies) assert.ok(!r.titles.some((x) => /^(?:complete|update|add sana|i am not asking)\b/i.test(x)), `${r.say}: ${r.titles.join(", ")}`);
  } finally {
    flags.forEach((f, i) => (keep[i] === undefined ? delete process.env[f] : (process.env[f] = keep[i])));
    await prisma.user.deleteMany({ where: { id: { in: created } } });
  }
});
