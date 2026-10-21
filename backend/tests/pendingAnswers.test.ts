import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma, RoutineFrequency, RoutinePriority, TaskType, type User } from "@prisma/client";
import { AiService, setAi } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import { handleAssistantMessage } from "../src/modules/assistant/dialogue.js";
import type { Pending, RoutineDraft, TaskDraft } from "../src/modules/assistant/types.js";
import { getOrCreateConversation } from "../src/modules/conversations/conversationService.js";
import { dbAvailable } from "./fixtures.js";

const skip = !dbAvailable && "no database";
const TZ = "Asia/Karachi";

/** The short replies from the review: each must be taken as an answer to whatever was asked. */
export const SHORT_REPLIES = ["yes", "no", "ok", "tomorrow", "2", "done", "5pm", "cancel", "haan", "nahi"];

const draft = (o: Partial<TaskDraft> = {}): TaskDraft => ({
  title: "Buy milk", description: null, dueYmd: null, dueTime: null, dateText: null, dateFuzzy: false, durationMinutes: null,
  priority: "MEDIUM", priorityExplicit: false, category: null, taskType: TaskType.DEADLINE, difficulty: null, tags: [], context: null, ...o,
});
const routineDraft: RoutineDraft = { title: "Gym", frequency: RoutineFrequency.DAILY, daysOfWeek: null, dayOfMonth: null, dueTime: null, flexibleTime: false, durationMinutes: null, priority: RoutinePriority.NORMAL, category: null, timeLocked: false, context: null };

/** One pending question of every kind, using real ids where the kind refers to rows. */
function pendings(ids: { task: string; task2: string; routine: string; routine2: string }, now: Date): Pending[] {
  return [
    { kind: "task_draft", draft: draft(), awaiting: ["time"], source: "CHAT", clarity: 60 },
    { kind: "task_review", draft: draft({ dueYmd: "2026-10-30", dueTime: "5 PM" }), source: "CHAT", clarity: 80 },
    { kind: "routine_draft", draft: routineDraft, awaiting: ["time"] },
    { kind: "mood_confirm", mood: "stressed", confidence: 0.8, text: "so much to do" },
    { kind: "confirm_update", taskId: ids.task, changes: {}, summary: "move it" },
    { kind: "confirm_delete", taskId: ids.task, title: "Essay" },
    { kind: "location_choice", taskId: ids.task, taskTitle: "Essay", place: "library", more: false, results: [
      { name: "Central Library", displayName: "Central Library, Lahore", latitude: 31.5, longitude: 74.3 },
      { name: "Quaid Library", displayName: "Quaid Library, Lahore", latitude: 31.6, longitude: 74.4 },
    ] },
    { kind: "choose_task", purpose: "complete", candidates: [ids.task, ids.task2], data: { text: "essay" } },
    { kind: "clarify_intent", text: "stuff" },
    { kind: "prereq", draft: draft({ dueYmd: "2026-10-30", dueTime: "5 PM" }), course: "CS201", prereq: "CS101", source: "CHAT" },
    { kind: "past_date", draft: draft({ dueYmd: "2026-10-01" }), source: "CHAT" },
    { kind: "typo", draft: draft({ title: "Buy mlik" }), source: "CHAT", corrected: "Buy milk" },
    { kind: "capacity", draft: draft({ dueYmd: "2026-10-30", durationMinutes: 600 }), source: "CHAT", ymd: "2026-10-30" },
    { kind: "conflict", draft: draft({ dueYmd: "2026-10-30", dueTime: "7 PM" }), source: "CHAT", routine: "Gym" },
    { kind: "confirm_command", command: "bulk_delete_completed", args: { taskIds: [ids.task2] }, summary: "Delete 1 completed task?", at: now.toISOString(), text: "delete all completed tasks" },
    { kind: "command_choice", command: "routine_pause", args: { ref: "reading" }, field: "routineId", candidates: [{ id: ids.routine, label: "Morning reading" }, { id: ids.routine2, label: "Night reading" }] },
  ];
}

async function withUser(fn: (user: User, ids: { task: string; task2: string; routine: string; routine2: string }) => Promise<void>) {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ } });
  try {
    const t1 = await prisma.task.create({ data: { userId: user.id, title: "Essay", priority: "MEDIUM", source: "CHAT" } });
    const t2 = await prisma.task.create({ data: { userId: user.id, title: "Essay draft", priority: "MEDIUM", source: "CHAT", status: "COMPLETED", completedAt: new Date() } });
    const r1 = await prisma.routine.create({ data: { userId: user.id, title: "Morning reading", frequency: "DAILY" } });
    const r2 = await prisma.routine.create({ data: { userId: user.id, title: "Night reading", frequency: "DAILY" } });
    await fn(user, { task: t1.id, task2: t2.id, routine: r1.id, routine2: r2.id });
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
}

async function ask(user: User, pending: Pending, text: string, now = new Date()) {
  const conversation = await getOrCreateConversation(user.id, "APP");
  await prisma.conversation.update({ where: { id: conversation.id }, data: { state: { pending, focus: [], prereqAsked: [], turn: 1 } as unknown as Prisma.InputJsonValue } });
  const settings = await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } });
  return handleAssistantMessage({ user, settings, deviceId: null, text, channel: "APP", conversationId: conversation.id, now });
}

test("pending questions consume short replies: every kind × yes / no / ok / tomorrow / 2 / done / 5pm / cancel / haan / nahi", { skip }, async () => {
  await withUser(async (user, ids) => {
    const misses: string[] = [];
    for (const kind of pendings(ids, new Date()).map((p) => p.kind)) {
      for (const reply of SHORT_REPLIES) {
        const pending = pendings(ids, new Date()).find((p) => p.kind === kind) as Pending;
        // Each case on its own: an earlier "yes" may have completed or deleted the fixture tasks.
        await prisma.task.update({ where: { id: ids.task }, data: { status: "PENDING", deletedAt: null, completedAt: null, progress: 0 } });
        await prisma.task.update({ where: { id: ids.task2 }, data: { status: "COMPLETED", deletedAt: null, completedAt: new Date() } });
        const out = await ask(user, pending, reply);
        if (out.message.answered !== kind) misses.push(`${kind} + "${reply}" → ${out.message.intent}`);
      }
    }
    assert.deepEqual(misses, []);
  });
});

test("a clear new command (not an answer) still drops the pending question", { skip }, async () => {
  await withUser(async (user, ids) => {
    const all = pendings(ids, new Date());
    const out = await ask(user, all.find((p) => p.kind === "confirm_command") as Pending, "pause my morning reading routine");
    assert.equal(out.message.answered, undefined);
    assert.equal(out.message.intent, "routine_paused");
    const out2 = await ask(user, all.find((p) => p.kind === "task_draft") as Pending, "mark all done");
    assert.equal(out2.message.answered, undefined);
  });
});

test("confirm_command expires after 10 minutes: a late yes does nothing and offers to show it again", { skip }, async () => {
  await withUser(async (user, ids) => {
    const asked = new Date("2026-10-21T10:00:00Z");
    const pending = pendings(ids, asked).find((p) => p.kind === "confirm_command") as Pending;
    const late = await ask(user, pending, "yes", new Date(asked.getTime() + 11 * 60000));
    assert.equal(late.message.intent, "confirm_expired");
    assert.equal(late.message.actions?.[0]?.text, "delete all completed tasks");
    assert.equal(await prisma.task.count({ where: { id: ids.task2, status: "DELETED" } }), 0);
    const inTime = await ask(user, pending, "yes", new Date(asked.getTime() + 9 * 60000));
    assert.equal(inTime.message.intent, "bulk_deleted");
  });
});
