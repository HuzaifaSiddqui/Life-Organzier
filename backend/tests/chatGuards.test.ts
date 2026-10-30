import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AiService, setAi, type LlmProvider } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import { zonedTimeToUtc } from "../src/lib/time.js";
import { getCommand, parseCtx } from "../src/modules/assistant/commands/registry.js";
import { handleAssistantMessage } from "../src/modules/assistant/dialogue.js";
import { explicitRoutine, guardModelChoice, type GuardVerdict, type RegistryFacts } from "../src/modules/assistant/guards.js";
import { rulesUnderstand } from "../src/modules/assistant/nlu.js";
import { dbAvailable, NOW, TZ } from "./fixtures.js";

// CHAT_FIXES_V2 guards (assistant/guards.ts). Invariants on what a model may decide, whatever it answers; written as
// tables, plus the sentences from the report. Not tuned on the AI-written sets.
const skip = !dbAvailable && "no database";
const opts = { now: NOW, tz: TZ };

function withFlag<T>(run: () => T): T {
  const keep = process.env.CHAT_FIXES_V2;
  process.env.CHAT_FIXES_V2 = "on";
  try {
    return run();
  } finally {
    if (keep === undefined) delete process.env.CHAT_FIXES_V2;
    else process.env.CHAT_FIXES_V2 = keep;
  }
}

const facts = (name: string): RegistryFacts => {
  const c = getCommand(name);
  return c ? { category: c.category, undoable: Boolean(c.undoable) } : { category: "general", undoable: false };
};

test("guard 1: a routine needs a repeat cue or 'routine/habit' with a create verb", () => {
  const rows: Array<[string, boolean]> = [
    ["gym every morning", true],
    ["read each night", true],
    ["walk daily", true],
    ["call grandma weekly", true],
    ["study on weekdays", true],
    ["swim on mondays and thursdays", true],
    ["add a routine to stretch", true],
    ["make reading a habit", true],
    ["start a new habit of journaling", true],
    ["play my workout playlist", false],
    ["booked the team lunch, tick it off", false],
    ["drink water", false],
    ["take my medicine after dinner", false],
    ["my morning routine is a mess", false],
  ];
  for (const [text, expected] of rows) assert.equal(explicitRoutine(text), expected, text);
  withFlag(() => {
    for (const text of ["play my workout playlist", "booked the team lunch, tick it off", "drink water", "meditate"]) {
      assert.notEqual(rulesUnderstand(text, opts).intent, "create_routine", `rules: ${text}`);
    }
    for (const text of ["meditate every morning", "add a routine to stretch"]) assert.equal(rulesUnderstand(text, opts).intent, "create_routine", `rules: ${text}`);
  });
});

test("guard 2: invariants on a model's choice (table)", () => {
  const rows: Array<{ text: string; choice: string; withdrawn?: string; expect: GuardVerdict; why: string }> = [
    // 2c undo never from the model
    { text: "can't make the reading session tonight", choice: "undo", expect: "forbidden", why: "undo only from an explicit phrase" },
    { text: "go back", choice: "undo", expect: "forbidden", why: "even a plausible one" },
    // 2b negation forbids complete-type
    { text: "not going to the gym today", choice: "routine_complete_today", expect: "forbidden", why: "negation" },
    { text: "I won't finish the essay", choice: "complete_task", expect: "forbidden", why: "negation" },
    { text: "skip the lab tag", choice: "bulk_complete_tag", expect: "forbidden", why: "negation" },
    { text: "don't tick the subtask", choice: "subtask_complete", expect: "forbidden", why: "negation" },
    { text: "didn't do the reading", choice: "complete_task", expect: "forbidden", why: "n't" },
    // 2a family the rules withdrew from (create_task / create_routine / complete_task → tasks and routines only)
    { text: "submitted the lab report", choice: "bulk_delete_open", withdrawn: "create_task", expect: "forbidden", why: "bulk is another family" },
    { text: "not going to yoga today", choice: "settings_dnd", withdrawn: "create_task", expect: "forbidden", why: "settings is another family" },
    { text: "what is due today?", choice: "insights_overdue", withdrawn: "create_task", expect: "forbidden", why: "insights is another family" },
    { text: "not going to yoga today", choice: "routine_skip_today", withdrawn: "create_task", expect: "confirm", why: "same family, changes data" },
    { text: "submitted the lab report", choice: "complete_task", withdrawn: "create_task", expect: "confirm", why: "same family, changes data" },
    { text: "what is due today?", choice: "query_tasks", withdrawn: "create_task", expect: "run", why: "same family, a read" },
    // 2d state-changing from the model: confirm; reads and new tasks run
    { text: "clear out the finished stuff", choice: "bulk_delete_completed", expect: "confirm", why: "bulk" },
    { text: "quiet please", choice: "settings_dnd", expect: "confirm", why: "settings" },
    { text: "the essay is now high priority", choice: "update_task", expect: "confirm", why: "edit" },
    { text: "lose the dentist one", choice: "delete_task", expect: "confirm", why: "delete" },
    { text: "play my workout playlist", choice: "create_routine", expect: "confirm", why: "routine without a cue" },
    { text: "how many did I finish this week", choice: "insights_completed", expect: "run", why: "read" },
    { text: "pick up the parcel", choice: "create_task", expect: "run", why: "a new task is not a change" },
  ];
  for (const r of rows) {
    assert.equal(guardModelChoice(r.text, r.choice, facts(r.choice), r.withdrawn ? facts(r.withdrawn) : null), r.expect, `${r.text} → ${r.choice}: ${r.why}`);
  }
  // Every complete-type command is forbidden under every negation word.
  const completes = ["complete_task", "routine_complete_today", "bulk_complete_tag", "subtask_complete"];
  for (const neg of ["not", "no", "can't", "cannot", "won't", "don't", "skip", "stop"]) {
    for (const c of completes) assert.equal(guardModelChoice(`${neg} the gym today`, c, facts(c), null), "forbidden", `${neg} → ${c}`);
  }
});

test("guard 3: 'notifications' with no task named is Do Not Disturb; a named task keeps its reminder mode", () => {
  withFlag(() => {
    const ctx = parseCtx({ now: NOW, timezone: TZ } as never);
    const dnd = getCommand("settings_dnd")!;
    const rows: Array<[string, Record<string, unknown> | null]> = [
      ["turn off notifications for 2 hours", { action: "on", minutes: 120 }],
      ["mute notifications for 90 minutes", { action: "on", minutes: 90 }],
      ["mute all alerts", { action: "on" }],
      ["I'm in class, turn off notifications for 2 hours", { action: "on", minutes: 120 }],
      ["turn off reminders for the essay", null],
      ["stop notifications about the lab report", null],
    ];
    for (const [text, expected] of rows) assert.deepEqual(dnd.parse(text, ctx), expected, text);
  });
});

// End to end: a model that always gives the bad answer. Whatever it says, nothing changes without a tap.
function adversary(answer: { intent: string; category: string; command: string; args?: Record<string, string> }): LlmProvider {
  const text = JSON.stringify({ ...answer, args: answer.args ?? {}, task_title: "", target_task: "", mood: "none" });
  return { name: "ollama", chat: async () => text };
}

async function snapshot(userId: string) {
  const strip = <T extends { updatedAt?: unknown }>(rows: T[]) => rows.map(({ updatedAt: _u, ...rest }) => rest);
  const [tasks, routines, occ, settings] = await Promise.all([
    prisma.task.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    prisma.routine.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    prisma.routineOccurrence.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    prisma.userSettings.findUniqueOrThrow({ where: { userId } }),
  ]);
  return JSON.stringify({ tasks: strip(tasks), routines: strip(routines), occ: strip(occ), settings: strip([settings])[0], routineCount: routines.length });
}

const REPORTED: Array<{ id: string; text: string; bad: Parameters<typeof adversary>[0] }> = [
  { id: "n-069", text: "booked the team lunch, tick it off", bad: { intent: "create_routine", category: "routines", command: "routine_pause", args: { ref: "gym" } } },
  { id: "n-100", text: "play my workout playlist", bad: { intent: "create_routine", category: "routines", command: "routine_complete_today", args: { ref: "gym" } } },
  { id: "n-016", text: "not going to the gym today", bad: { intent: "complete_task", category: "routines", command: "routine_complete_today", args: { ref: "gym" } } },
  { id: "n-018", text: "can't make the reading session tonight", bad: { intent: "unclear", category: "general", command: "undo" } },
  { id: "n-032", text: "turn off notifications for 2 hours", bad: { intent: "update_task", category: "tasks", command: "task_reminder_mode", args: { ref: "team lunch", mode: "NONE" } } },
  { id: "n-087", text: "mute notifications for 90 minutes", bad: { intent: "update_task", category: "tasks", command: "task_reminder_mode", args: { ref: "team lunch", mode: "NONE" } } },
  { id: "bulk", text: "clear my plate", bad: { intent: "delete_task", category: "bulk", command: "bulk_delete_open" } },
];

test("reported sentences with an adversarial model: no change, no routine, no undo without the user's tap", { skip }, async () => {
  for (const row of REPORTED) {
    const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
    await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ, tier: "PRO" } });
    const keep = process.env.CHAT_FIXES_V2;
    process.env.CHAT_FIXES_V2 = "on";
    try {
      const gym = await prisma.routine.create({ data: { userId: user.id, title: "Gym", frequency: "DAILY", dueTime: "6 PM", createdAt: new Date("2026-09-01T00:00:00Z") } });
      await prisma.routineOccurrence.create({ data: { userId: user.id, routineId: gym.id, occurrenceDate: zonedTimeToUtc("2026-10-05", 0, 0, TZ), dueTime: "6 PM" } });
      await prisma.task.create({ data: { userId: user.id, title: "Team lunch", priority: "MEDIUM", source: "CHAT", dueAt: zonedTimeToUtc("2026-10-05", 13, 0, TZ) } });
      await prisma.task.create({ data: { userId: user.id, title: "Essay draft", priority: "MEDIUM", source: "CHAT", status: "COMPLETED", completedAt: NOW } });
      const send = async (text: string) =>
        (await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, channel: "APP", now: NOW, text, payload: null, label: null })).message as { content: string; intent?: string };
      // Something undoable first (rules, confident), so a wrong undo would show.
      setAi(new AiService([]));
      await send("mark team lunch as done");
      const before = await snapshot(user.id);
      setAi(new AiService([adversary(row.bad)]));
      const out = await send(row.text);
      const after = await snapshot(user.id);
      const isDnd = /notifications/.test(row.text);
      if (isDnd) {
        // Guard 3: Do Not Disturb, never the task's reminder mode.
        const t = JSON.parse(after).tasks as Array<{ reminderMode: string }>;
        assert.deepEqual(t.map((x) => x.reminderMode), JSON.parse(before).tasks.map((x: { reminderMode: string }) => x.reminderMode), `${row.id}: reminder modes unchanged`);
        assert.ok(out.intent === "settings_dnd_on" || out.intent === "settings_dnd" || out.intent === "meaning_ask", `${row.id}: Do Not Disturb (${out.intent})`);
      } else {
        const b = JSON.parse(before);
        const a = JSON.parse(after);
        assert.equal(a.routineCount, b.routineCount, `${row.id}: no routine created (${out.intent}: ${out.content})`);
        assert.deepEqual(a.occ, b.occ, `${row.id}: no routine occurrence changed (${out.intent})`);
        assert.deepEqual(a.routines, b.routines, `${row.id}: no routine changed (${out.intent})`);
        assert.deepEqual(a.settings, b.settings, `${row.id}: settings unchanged (${out.intent})`);
        for (const t of b.tasks) assert.deepEqual(a.tasks.find((x: { id: string }) => x.id === t.id), t, `${row.id}: existing task unchanged (${out.intent})`);
      }
    } finally {
      if (keep === undefined) delete process.env.CHAT_FIXES_V2;
      else process.env.CHAT_FIXES_V2 = keep;
      setAi(new AiService([]));
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
});
