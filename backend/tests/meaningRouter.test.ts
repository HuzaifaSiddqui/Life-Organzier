import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AiService, setAi, type ChatMessage } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
// The registry first, as in the app: it loads every command module in order.
import { parseCtx } from "../src/modules/assistant/commands/registry.js";
import { meaningRoute } from "../src/modules/assistant/commands/meaning.js";
import { hashIndex, type BankRow } from "../src/modules/assistant/commands/neighbours.js";
import { handleAssistantMessage } from "../src/modules/assistant/dialogue.js";
import { dbAvailable } from "./fixtures.js";

const skip = !dbAvailable && "no database";
const ctx = parseCtx({ now: new Date("2026-10-05T05:00:00Z"), tz: "Asia/Karachi" });
/** A bank where five rows say exactly `text` means `command`: the strongest possible neighbour vote. */
const bankSaying = (text: string, command: string) =>
  hashIndex(Array.from({ length: 5 }, (_, i): BankRow => ({ id: `s${i}`, text, lang: "en", command })));
/** A model that routes every message to one command (area, then command). */
function modelPicking(command: string, category: string) {
  const prompts: string[] = [];
  setAi(
    new AiService([
      {
        name: "scripted",
        chat: async (messages: ChatMessage[]) => {
          const system = messages[0]?.content ?? "";
          prompts.push(system);
          if (system.includes("route a message")) return JSON.stringify({ category });
          if (system.includes("Pick the one command")) return JSON.stringify({ command, args: {} });
          return "{}";
        },
      },
    ]),
  );
  return prompts;
}

test("AI off: sure rules decide; neighbours alone never route; nothing like the bank → unknown", async () => {
  setAi(new AiService([]));
  const bank = bankSaying("pause my gym routine", "routine_delete");
  const sure = await meaningRoute("pause my gym routine", ctx, { command: "routine_pause", confidence: 1 }, { index: bank, model: false });
  assert.equal(sure.decision.kind, "rules", "no model: a strong disagreement alone never overrides or asks");
  const unsure = await meaningRoute("pause my gym routine", ctx, { command: "create_task", confidence: 0.4 }, { index: bank, model: false });
  assert.equal(unsure.decision.kind, "rules", "neighbours alone are off (the gate: 43% / 29%)");
  const lost = await meaningRoute("blorp zinga", ctx, { command: "unclear", confidence: 0.2 }, { index: bank, model: false });
  assert.equal(lost.decision.kind, "unknown");
});

test("arbitration: sure rules, and neighbours and the model both say otherwise → one question; the model alone → rules", async () => {
  const bank = bankSaying("pause my gym routine", "routine_delete");
  modelPicking("routine_delete", "routines");
  const asked = await meaningRoute("pause my gym routine", ctx, { command: "routine_pause", confidence: 1 }, { index: bank, model: true });
  assert.deepEqual(asked.decision, { kind: "ask", options: ["routine_pause", "routine_delete"] });
  modelPicking("routine_list", "routines");
  const kept = await meaningRoute("pause my gym routine", ctx, { command: "routine_pause", confidence: 1 }, { index: bank, model: true });
  assert.equal(kept.decision.kind, "rules", "the model disagrees with the neighbours: the rules stand");
});

test("unsure rules, model on: the nearest bank examples are in the router prompt and the model's command runs", async () => {
  const bank = bankSaying("give me the numbers about my productivity", "insights_completed");
  const prompts = modelPicking("insights_completed", "insights");
  const r = await meaningRoute("give me the numbers about my productivity", ctx, { command: "unclear", confidence: 0.2 }, { index: bank, model: true });
  assert.equal(r.decision.kind === "route" && r.decision.command, "insights_completed");
  assert.ok(prompts.some((p) => p.includes('Similar messages and their commands') && p.includes('"give me the numbers about my productivity" → insights_completed')));
  const sure = await meaningRoute("show my routines", ctx, { command: "routine_list", confidence: 0.8 }, { index: bank, model: true });
  assert.equal(sure.decision.kind, "rules", "0.75–0.85: the rules keep it and the model is not called (no new model calls)");
});

test("an unknown message: \"I can't do that yet\", 3 things I can do, and a log row with no user id and masked numbers", { skip }, async () => {
  setAi(new AiService([]));
  const path = join(mkdtempSync(join(tmpdir(), "unknown-")), "unknown-utterances.jsonl");
  process.env.UNKNOWN_LOG_PATH = path;
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: "Asia/Karachi" } });
  try {
    const r = await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, text: "zorb the wibble 0300-1234567 quantumly", channel: "APP", now: new Date("2026-10-05T05:00:00Z") });
    assert.equal(r.message.intent, "unknown");
    assert.match(r.message.content, /^I can't do that yet/);
    assert.equal(r.message.actions?.length, 3);
    assert.ok(r.message.actions?.every((a) => a.payload), "the suggestions follow the action contract");
    const rows = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]).sort(), ["at", "lang", "text"]);
    assert.doesNotMatch(String(rows[0].text), /1234567/, "personal numbers are masked");
    assert.doesNotMatch(JSON.stringify(rows[0]), new RegExp(user.id));
    assert.equal(rows[0].at, "2026-10-05T05:00:00.000Z");
  } finally {
    process.env.UNKNOWN_LOG_PATH = "off";
    await prisma.user.delete({ where: { id: user.id } });
  }
});
