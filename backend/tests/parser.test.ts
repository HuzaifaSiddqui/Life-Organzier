import assert from "node:assert/strict";
import test from "node:test";
import { Priority } from "@prisma/client";
import { AiService } from "../src/ai/ai.service.js";
import type { SemanticTaskExtraction } from "../src/ai/providers/provider.interface.js";
import { parseTaskFromText, parseTaskFromTextHybrid } from "../src/modules/parser/taskParserService.js";

function mockAi(extraction: SemanticTaskExtraction): AiService {
  return new AiService({
    name: "test-provider",
    async extractTask() {
      return extraction;
    },
  });
}

test("semantic extraction turns conversational pee reminder into an actionable task", async () => {
  const result = await parseTaskFromTextHybrid(
    "add a task that will help me to remind to pee",
    undefined,
    mockAi({
      title: "Pee",
      description: "Take a bathroom break",
      category: "Health",
      priority: Priority.MEDIUM,
      confidence: 95,
    }),
  );

  assert.equal(result.title, "Pee");
  assert.equal(result.description, "Take a bathroom break");
  assert.equal(result.category, "Health");
});

test("deterministic rules extract tomorrow and 5 PM", () => {
  const result = parseTaskFromText("remind me tomorrow at 5 PM to call my mother", {
    clientTodayYmd: "2026-09-30",
  });

  assert.equal(result.title, "call my mother");
  assert.equal(result.dueDateText, "tomorrow");
  assert.equal(result.dueTime, "5 PM");
});

test("semantic extraction removes task commands before saving assignment intent", async () => {
  const result = await parseTaskFromTextHybrid(
    "please create a task for submitting my assignment next Monday",
    { clientTodayYmd: "2026-09-30" },
    mockAi({
      title: "Submit assignment",
      description: null,
      category: "Academic",
      priority: Priority.MEDIUM,
      confidence: 94,
    }),
  );

  assert.equal(result.title, "Submit assignment");
  assert.equal(result.dueDateText, "next Monday");
});

test("simple tasks remain confirmation-worthy when no due information exists", () => {
  const result = parseTaskFromText("buy groceries");

  assert.equal(result.title, "buy groceries");
  assert.equal(result.dueDateIso, null);
  assert.equal(result.dueTime, null);
  assert.equal(result.needsConfirmation, true);
});

test("voice-style reminder uses the same semantic pipeline", async () => {
  const result = await parseTaskFromTextHybrid(
    "Remind me to drink water every morning",
    undefined,
    mockAi({
      title: "Drink water",
      description: "Drink water every morning",
      category: "Health",
      priority: Priority.MEDIUM,
      confidence: 93,
    }),
  );

  assert.equal(result.title, "Drink water");
  assert.equal(result.category, "Health");
  assert.equal(result.dueTime, "morning");
});