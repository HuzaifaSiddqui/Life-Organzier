import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AiService, setAi } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import "../src/modules/assistant/commands/registry.js";
import { MEDICAL_REPLY, medicalQuestion } from "../src/modules/assistant/appQuestions.js";
import { handleAssistantMessage } from "../src/modules/assistant/dialogue.js";
import { dbAvailable, TZ } from "./fixtures.js";

/** Safety (no flag): medical advice is never answered by the model. New sentences, not the persona messages. */
const ASKS = [
  "how much paracetamol can I give my 4 year old?",
  "what's the right dosage of ibuprofen for an adult",
  "how many mg of panadol is safe",
  "is 500mg enough for a toothache",
  "what medicine should I take for a fever",
  "which antibiotic is best for a sore throat?",
  "what should I take for a migraine",
  "what can we give for a cough at night",
  "can I take brufen with augmentin?",
  "is it safe to give calpol to a baby",
  "how many tablets should I take for back pain",
  "Tell me the maximum dose of metformin",
];
const NOT_ASKS = [
  "remind me to take my medicine at 9 pm",
  "add a task to ask the doctor about the dosage",
  "take my vitamins every morning at 8",
  "did I take my dose today?",
  "when is my insulin dose?",
  "buy paracetamol from the pharmacy tomorrow",
  "which tablet should I buy, iPad or Samsung?",
  "can I take my tablet to the exam",
  "what's due for ML this week?",
  "how many tasks do I have left",
  "I took my antibiotics",
  "book a doctor's appointment for Friday",
  "log my medication as done",
  "what should I take for the trip",
  "what is my plan for today",
  "I have a headache",
];

test("medicalQuestion: dose / which medicine / mixing questions (English); reminders and tasks pass", () => {
  for (const t of ASKS) assert.equal(medicalQuestion(t), true, `guarded: ${t}`);
  for (const t of NOT_ASKS) assert.equal(medicalQuestion(t), false, `not guarded: ${t}`);
});

test("chat: a dose question gets the fixed reply and never reaches the model; a medicine reminder is still a task", { skip: !dbAvailable && "no database" }, async () => {
  let modelCalls = 0;
  // A model that would answer with a dose: the guard must answer first.
  setAi(new AiService([{ name: "fake", chat: async () => { modelCalls += 1; return "Give 250 mg three times a day."; } }]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ, tier: "PRO" } });
  const conversation = await prisma.conversation.create({ data: { userId: user.id, channel: "APP", title: "t" } });
  const send = async (text: string) =>
    (await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, channel: "APP", conversationId: conversation.id, now: new Date("2026-11-12T12:00:00Z"), text, payload: null, label: null } as never)).message;
  try {
    for (const flags of ["", "on"]) {
      const keep = process.env.CHAT_FIXES_V2;
      process.env.CHAT_FIXES_V2 = flags;
      try {
        const m = await send("how much paracetamol can I give my 4 year old?");
        assert.equal(m.intent, "medical_question", `CHAT_FIXES_V2="${flags}"`);
        assert.equal(m.content, MEDICAL_REPLY);
        assert.doesNotMatch(m.content, /\d+\s?mg/);
        assert.deepEqual((m.actions ?? []).map((a) => a.label), ["Remind me to call the doctor"]);
      } finally {
        if (keep === undefined) delete process.env.CHAT_FIXES_V2;
        else process.env.CHAT_FIXES_V2 = keep;
      }
    }
    assert.equal(modelCalls, 0, "the model is never asked");
    assert.equal(await prisma.task.count({ where: { userId: user.id } }), 0, "no task from a question");
    const reminder = await send("remind me to take my medicine at 9 pm");
    assert.notEqual(reminder.intent, "medical_question");
    assert.equal(await prisma.task.count({ where: { userId: user.id } }), 1, "a medicine reminder is still a task");
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});
