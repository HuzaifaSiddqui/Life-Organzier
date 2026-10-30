import assert from "node:assert/strict";
import test from "node:test";
import { classify, parseCtx } from "../src/modules/assistant/commands/registry.js";
import { rulesUnderstand } from "../src/modules/assistant/nlu.js";
import { NOW, TZ } from "./fixtures.js";

// New sentences written for these tests (none from tests/eval/chat-heldout-ai-written.json).
const opts = { now: NOW, tz: TZ };
function intents(texts: string[], on: boolean): string[] {
  const keep = process.env.CHAT_FIXES_V2;
  if (on) process.env.CHAT_FIXES_V2 = "on";
  else delete process.env.CHAT_FIXES_V2;
  try {
    return texts.map((t) => rulesUnderstand(t, opts).intent);
  } finally {
    if (keep === undefined) delete process.env.CHAT_FIXES_V2;
    else process.env.CHAT_FIXES_V2 = keep;
  }
}
const CREATE_OR_COMPLETE = new Set(["create_task", "create_routine", "complete_task"]);

test("D: questions and show/list requests never create or complete", () => {
  const asks = ["did I write anything down about the hostel fee", "am I busy on wednesday evening", "is the physics quiz this week", "list my morning routines", "show my reading habit"];
  assert.ok(intents(asks, true).every((i) => !CREATE_OR_COMPLETE.has(i)), JSON.stringify(intents(asks, true)));
  // Requests that ask for a task outright still make one.
  assert.deepEqual(intents(["can you remind me to pay rent tomorrow?", "could you add buy printer ink to my list?"], true), ["create_task", "create_task"]);
});

test("E: a past-tense report completes the matching item instead of creating one", () => {
  assert.equal(intents(["submitted my lab report"], true)[0], "complete_task");
  // E only replaces a creation: where the rules would do nothing ("unclear"), nothing is completed either.
  const reports = ["submitted my lab report", "I already paid the hostel fee", "finally watered the balcony plants", "took the bins out"];
  assert.ok(intents(reports, true).every((i) => i !== "create_task" && i !== "create_routine"), JSON.stringify(intents(reports, true)));
  assert.notEqual(intents(["paid rent, remind me again next month"], true)[0], "complete_task", "a future cue keeps it a task");
});

test("H: not doing, skipping or stopping something never creates", () => {
  const no = ["not going to the yoga class today", "skipping my evening run", "I won't do the laundry tonight", "stop my journaling routine"];
  assert.ok(intents(no, true).every((i) => i !== "create_task" && i !== "create_routine"), JSON.stringify(intents(no, true)));
});

test("I: a feeling is a mood report, not a task; an explicit time keeps a task", () => {
  assert.deepEqual(intents(["feeling anxious about the viva today", "I'm exhausted tonight"], true), ["log_mood", "log_mood"]);
  assert.equal(intents(["feeling sick, remind me to call the clinic at 10 am"], true)[0], "create_task");
});

test("flag off: the rules decide exactly as before", () => {
  const all = ["submitted my lab report", "am I busy on wednesday evening", "skipping my evening run", "feeling anxious about the viva today", "can you remind me to pay rent tomorrow?"];
  const off = intents(all, false);
  const keep = process.env.CHAT_FIXES_V2;
  delete process.env.CHAT_FIXES_V2;
  assert.deepEqual(off, all.map((t) => rulesUnderstand(t, opts).intent));
  if (keep !== undefined) process.env.CHAT_FIXES_V2 = keep;
});

function understood(text: string, on: boolean) {
  const keep = process.env.CHAT_FIXES_V2;
  if (on) process.env.CHAT_FIXES_V2 = "on";
  else delete process.env.CHAT_FIXES_V2;
  try {
    return rulesUnderstand(text, opts);
  } finally {
    if (keep === undefined) delete process.env.CHAT_FIXES_V2;
    else process.env.CHAT_FIXES_V2 = keep;
  }
}

test("A: no repeat without a real repeat cue", () => {
  assert.notEqual(understood("prepare the weekly newsletter on thursday", true).intent, "create_routine", "an adjective with a date is a one-off");
  assert.equal(understood("daily standup at 9", true).intent, "create_routine", "no date: still a repeat");
  assert.notEqual(understood("buy samosas for lunch", true).intent, "create_routine", "a meal word as a modifier");
  assert.equal(understood("take my vitamins after breakfast", true).intent, "create_routine", "the habit itself");
});

test("B: every weekday is Monday to Friday", () => {
  const u = understood("stand-up every weekday at 9:30", true);
  assert.equal(u.intent, "create_routine");
  assert.deepEqual(u.entities.daysOfWeek, [1, 2, 3, 4, 5]);
  assert.equal(understood("stand-up every weekday at 9:30", false).entities.daysOfWeek, null, "flag off: as before");
});

function classified(text: string, on: boolean) {
  const keep = process.env.CHAT_FIXES_V2;
  if (on) process.env.CHAT_FIXES_V2 = "on";
  else delete process.env.CHAT_FIXES_V2;
  try {
    return classify(text, parseCtx({ now: NOW, tz: TZ, contexts: ["At Home", "At Work"] }));
  } finally {
    if (keep === undefined) delete process.env.CHAT_FIXES_V2;
    else process.env.CHAT_FIXES_V2 = keep;
  }
}

test("G: a status clause in front of an instruction: the instruction decides", () => {
  assert.equal(classified("finally home, undo that", true).command, "undo");
  assert.equal(classified("finally home, undo that", false).command, "unclear", "flag off: as before");
  assert.equal(classified("long week, buy groceries tomorrow", true).command, "create_task", "an ordinary task is unchanged");
});

test("F: ranking and time words are not search terms", () => {
  const on = classified("anything about the hostel right now?", true);
  assert.equal(on.command, "find_items");
  assert.deepEqual(on.args.terms, ["hostel"]);
});
