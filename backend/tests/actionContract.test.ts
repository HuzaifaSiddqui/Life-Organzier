import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { User } from "@prisma/client";
import { AiService, setAi } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import { zonedTimeToUtc } from "../src/lib/time.js";
// The registry first, as in the app: it loads every command module in order.
import "../src/modules/assistant/commands/registry.js";
import { handleAssistantMessage } from "../src/modules/assistant/dialogue.js";
import type { ActionPayload, QuickAction } from "../src/modules/assistant/types.js";
import { dbAvailable } from "./fixtures.js";

/**
 * The action contract (docs/chat-failures.md): every button the engine emits carries a payload, and sending it
 * back runs what it names. Each scenario is run once to collect its buttons, then again from scratch for every
 * button, which is tapped in the state it was shown in.
 */
const skip = !dbAvailable && "no database";
const TZ = "Asia/Karachi";
/** Pinned clock: Monday 5 Oct 2026, 10:00 in Karachi. */
const NOW = new Date("2026-10-05T05:00:00Z");
const at = (ymd: string, h: number) => zonedTimeToUtc(ymd, h, 0, TZ);

type Scenario = { name: string; setup?: (user: User) => Promise<unknown>; say: string[] };
const task = (user: User, title: string, o: Record<string, unknown> = {}) =>
  prisma.task.create({ data: { userId: user.id, title, priority: "MEDIUM", source: "CHAT", dueAt: at("2026-10-05", 18), dueDate: at("2026-10-05", 0), ...o } });
const routine = (user: User, title: string, dueTime = "7 AM") => prisma.routine.create({ data: { userId: user.id, title, frequency: "DAILY", dueTime } });

const SCENARIOS: Scenario[] = [
  { name: "new routine", say: ["Gym every Tuesday and Friday at 9 AM"] },
  { name: "task without a date", say: ["Submit the history report"] },
  { name: "a date in the past", say: ["Call Ali yesterday at 5 PM"] },
  { name: "today's list", setup: (u) => task(u, "Physics lab"), say: ["What do I have today?"] },
  { name: "no such task", setup: (u) => task(u, "Physics lab"), say: ["delete the zebra task"] },
  { name: "which task?", setup: async (u) => (await task(u, "Physics lab report"), task(u, "Physics essay")), say: ["mark physics done"] },
  { name: "check-in style", say: ["Make check-ins gentle"] },
  { name: "check-ins off", say: ["Turn off check-ins"] },
  { name: "help", say: ["What can you do?"] },
  { name: "not understood", say: ["blorp zinga"] },
  { name: "quiet hours", say: ["what are my quiet hours?"] },
  { name: "DND on", say: ["DND for 1 hour"] },
  { name: "overdue count", setup: (u) => task(u, "Old essay", { dueAt: at("2026-10-01", 12), dueDate: at("2026-10-01", 0) }), say: ["how many tasks are overdue?"] },
  { name: "no such routine", setup: (u) => routine(u, "Gym"), say: ["pause my yoga routine"] },
  { name: "mood", say: ["I am stressed"] },
  { name: "mood confirmed", say: ["I am stressed", "yes"] },
  { name: "bulk delete preview", setup: (u) => task(u, "Done thing", { status: "COMPLETED", completedAt: NOW }), say: ["delete all completed tasks"] },
  { name: "routine without frequency", say: ["Add a routine", "stretching"] },
  { name: "unknown category", setup: (u) => task(u, "Essay"), say: ["put the essay in the Banana category"] },
  { name: "which routine?", setup: async (u) => (await routine(u, "Gym morning"), routine(u, "Gym evening", "7 PM")), say: ["pause gym routine"] },
];

async function run(s: Scenario, tap?: QuickAction) {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ, tier: "PRO" } });
  try {
    await s.setup?.(user);
    const send = async (input: { text?: string; payload?: ActionPayload; label?: string }) =>
      (await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, channel: "APP", now: NOW, text: input.text ?? null, payload: input.payload ?? null, label: input.label ?? null })).message;
    let last = await send({ text: s.say[0] });
    for (const text of s.say.slice(1)) last = await send({ text });
    if (!tap) return { shown: (last.actions ?? []) as QuickAction[] };
    return { shown: [], tapped: await send({ payload: tap.payload, label: tap.label }) };
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
}

test("every emitted button carries a payload, and tapping it runs what it names", { skip }, async () => {
  const problems: string[] = [];
  let buttons = 0;
  const seen = new Set<string>();
  for (const s of SCENARIOS) {
    const { shown } = await run(s);
    if (!shown.length) problems.push(`${s.name}: no buttons (the scenario no longer reaches its question)`);
    for (const action of shown) {
      buttons += 1;
      if (!action.payload) {
        problems.push(`${s.name} / "${action.label}": no payload`);
        continue;
      }
      seen.add(action.payload.type);
      const p = action.payload;
      // App-only actions are handled on the phone (open a screen); the server only acknowledges them.
      if (p.type === "open_task" || p.type === "navigate") continue;
      const { tapped } = await run(s, action);
      const m = tapped as { intent?: string; command?: string; answered?: string; content: string };
      const where = `${s.name} / "${action.label}" (${JSON.stringify(p)}) → ${m.intent}: ${m.content.slice(0, 90)}`;
      if (process.env.CONTRACT_LOG) console.log(`TAP ${where}`);
      if (["noop", "error", "unknown_command", "invalid_args", "answer_closed"].includes(m.intent ?? "")) problems.push(`${where}: did nothing`);
      // A button is specific: it never ends in "which one?", "not found" or "I'm not sure".
      else if (p.type === "command" && ["not_found", "routine_not_found", "command_choice", "choose_task", "unclear", "clarify_intent"].includes(m.intent ?? "")) problems.push(`${where}: not specific`);
      else if (p.type === "command" && m.command !== p.command) problems.push(`${where}: ran ${m.command ?? "no command"}`);
      else if (p.type === "answer" && m.answered !== p.pending) problems.push(`${where}: did not answer ${p.pending}`);
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join("\n")}`);
  assert.ok(buttons >= 55, `only ${buttons} buttons exercised`);
  for (const type of ["command", "answer", "confirm_pending", "cancel_pending", "undo_command", "talk"]) assert.ok(seen.has(type), `no ${type} button exercised`);
});
