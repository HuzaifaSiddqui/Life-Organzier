import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Priority, TaskSource, TaskType } from "@prisma/client";
import { AiService, setAi, type ChatMessage, type CompletionOptions, type LlmProvider } from "../src/ai/llm.js";
import {
  generateCheckinCopy,
  isCopyStale,
  messageFor,
  renderTemplate,
  templateCopy,
  validateCheckinMessage,
  type CopyMessage,
} from "../src/modules/checkins/copy.js";
import { ACK_TEMPLATES, TEMPLATES, type CopyKind, type Lang, type Tone } from "../src/modules/checkins/templates.js";
import { prisma } from "../src/config/db.js";
import { createTask, updateTask } from "../src/modules/tasks/taskService.js";
import { dbAvailable } from "./fixtures.js";

const task = { id: "t1", title: "Physics assignment", durationMinutes: 120, scheduledStart: new Date("2026-10-05T11:00:00Z") };
const long = { ...task, id: "t2", title: "Prepare the final presentation for software engineering", durationMinutes: 150 };
const en = { language: "en", checkinTone: "FUNNY" };
const ur = { language: "ur", checkinTone: "FUNNY" };
const KINDS: CopyKind[] = ["START", "START_FOLLOWUP", "COMPLETION", "COMPLETION_UNCONFIRMED"];
const TONES: Tone[] = ["FUNNY", "SERIOUS", "GENTLE"];
const LANGS: Lang[] = ["en", "ur"];

class MockProvider implements LlmProvider {
  readonly name = "mock";
  calls: CompletionOptions[] = [];
  constructor(private readonly reply: unknown) {}
  async chat(_m: ChatMessage[], options: CompletionOptions): Promise<string> {
    this.calls.push(options);
    return JSON.stringify(this.reply);
  }
}

test("templates: ≥ 4 per kind × tone × language, with and without a first step", () => {
  for (const lang of LANGS)
    for (const tone of TONES)
      for (const kind of KINDS) {
        const list = TEMPLATES[lang][tone][kind];
        assert.ok(list.length >= 4, `${lang}/${tone}/${kind}`);
        assert.ok(list.some((t) => !t.includes("{firstStep}")), `${lang}/${tone}/${kind} needs a template without a first step`);
        if (kind === "START" || kind === "START_FOLLOWUP") assert.ok(list.some((t) => t.includes("{firstStep}")), `${lang}/${tone}/${kind} needs a first-step template`);
      }
});

test("templates: every template fits and validates with a typical title and first step", () => {
  const step = { en: "Open the problem set", ur: "سوالات کا پہلا صفحہ کھولیں" };
  for (const lang of LANGS)
    for (const tone of TONES)
      for (const kind of KINDS)
        for (const [i, template] of TEMPLATES[lang][tone][kind].entries()) {
          const firstStep = template.includes("{firstStep}") ? step[lang] : null;
          const text = template
            .replace("{task}", task.title)
            .replace("{duration}", lang === "en" ? "2 hours" : "2 گھنٹے")
            .replace("{firstStep}", firstStep ?? "");
          assert.ok(text.length <= 120, `${lang}/${tone}/${kind}#${i} is ${text.length} chars: ${text}`);
          const v = validateCheckinMessage(text, { language: lang, title: task.title, firstStep });
          assert.ok(v.ok, `${lang}/${tone}/${kind}#${i}: ${JSON.stringify(v)} — ${text}`);
        }
  for (const lang of LANGS) for (const list of Object.values(ACK_TEMPLATES[lang])) for (const t of list) assert.ok(t.length <= 120);
});

test("templates: rendering always fits 120 chars, even with the longest title and a 60-char first step", () => {
  const step = { en: "Open the slide deck and outline the first three main sections", ur: "پریزنٹیشن کھولیں اور پہلے تین حصوں کا خاکہ بنائیں تاکہ آغاز آسان ہو" };
  for (const lang of LANGS)
    for (const tone of TONES)
      for (const kind of KINDS)
        for (const id of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
          const t = { ...long, id };
          const m = renderTemplate(kind, tone, lang, t, step[lang].slice(0, 60));
          assert.ok(m.text.length <= 120, `${lang}/${tone}/${kind}: ${m.text.length} — ${m.text}`);
          assert.ok(validateCheckinMessage(m.text, { language: lang, title: t.title, firstStep: m.hasFirstStep ? step[lang].slice(0, 60) : null }).ok, m.text);
        }
});

test("templates: Gentle start/follow-up offers to split the task and never jokes", () => {
  const offers = /split|smaller|بانٹ|حصوں/;
  for (const lang of LANGS)
    for (const kind of ["START", "START_FOLLOWUP"] as CopyKind[]) {
      assert.ok(TEMPLATES[lang].GENTLE[kind].filter((t) => offers.test(t)).length >= 2, `${lang}/${kind}`);
    }
  for (const lang of LANGS) for (const kind of KINDS) for (const t of TEMPLATES[lang].GENTLE[kind]) assert.doesNotMatch(t, /knock|plot twist|victory|encore|runway|دستک|رن وے|جشن/i);
});

test("validator: length, banned words, emoji, task mention and language", () => {
  const ctx = { language: "en" as Lang, title: "Physics assignment", firstStep: "Open Q1" };
  assert.deepEqual(validateCheckinMessage("Physics assignment time! Started?", ctx), { ok: true });
  assert.deepEqual(validateCheckinMessage("Ready? Begin with: Open Q1", ctx), { ok: true }, "first step alone is enough");
  assert.deepEqual(validateCheckinMessage(`Physics assignment ${"x".repeat(110)}`, ctx), { ok: false, reason: "too_long" });
  for (const bad of ["Physics assignment — don't be lazy", "Physics assignment again?", "I'm disappointed about Physics assignment", "Physics assignment: failure is not an option"]) {
    assert.deepEqual(validateCheckinMessage(bad, ctx), { ok: false, reason: "banned_word" }, bad);
  }
  assert.deepEqual(validateCheckinMessage("Physics assignment 🚀🔥 go!", ctx), { ok: false, reason: "too_many_emoji" });
  assert.deepEqual(validateCheckinMessage("Physics assignment 🚀 go!", ctx), { ok: true });
  assert.deepEqual(validateCheckinMessage("Time to start your task. Ready?", ctx), { ok: false, reason: "no_task_or_step" });
  assert.deepEqual(validateCheckinMessage("Physics assignment شروع کریں", ctx), { ok: false, reason: "wrong_language" });
  const urCtx = { language: "ur" as Lang, title: "Physics assignment", firstStep: null };
  assert.deepEqual(validateCheckinMessage("Physics assignment شروع کرنے کا وقت ہے۔ تیار ہیں؟", urCtx), { ok: true }, "English title inside Urdu is fine");
  assert.deepEqual(validateCheckinMessage("Physics assignment time to start, are you ready?", urCtx), { ok: false, reason: "wrong_language" });
  assert.deepEqual(validateCheckinMessage("Physics assignment میں سست نہ بنیں", urCtx), { ok: false, reason: "banned_word" });
});

test("copy: AI unavailable → template copy in the saved style and Gentle; check-in still has a message", async () => {
  setAi(new AiService([]));
  const copy = await generateCheckinCopy(task, en);
  assert.equal(copy.savedTone, "FUNNY", "new users default to Funny");
  assert.equal(copy.firstStep, null);
  assert.deepEqual(Object.keys(copy.messages).sort(), ["FUNNY", "GENTLE"]);
  for (const tone of ["FUNNY", "GENTLE"] as Tone[]) for (const k of KINDS) assert.equal(copy.messages[tone]?.[k].source, "TEMPLATE");
  assert.match(messageFor(copy, "START", "FUNNY", task).text, /Physics assignment/);
  // Saved Gentle: only one set is needed.
  assert.deepEqual(Object.keys(templateCopy(task, { language: "en", checkinTone: "GENTLE" }).messages), ["GENTLE"]);
  // Urdu users get Urdu templates.
  assert.match(templateCopy(task, ur).messages.FUNNY!.START.text, /[؀-ۿ]/);
});

const llmReply = {
  firstStep: "Open the problem set",
  style: {
    start: "Physics assignment is up! Open the problem set and you're rolling. Started?",
    followup: "Still there, Physics assignment? Open the problem set — 5 minutes.",
    completion: "Physics assignment: done, or one more round?",
    completionUnconfirmed: "How did Physics assignment go?",
  },
  gentle: {
    start: "No rush. Open the problem set for Physics assignment. Want to split it?",
    followup: "Physics assignment can be split into smaller steps. Open the problem set?",
    completion: "How far did Physics assignment get? Any progress counts.",
    completionUnconfirmed: "How did Physics assignment go today? That's okay either way.",
  },
};

test("copy: valid LLM output is used, in the background queue, with the first step", async () => {
  const provider = new MockProvider(llmReply);
  setAi(new AiService([provider]));
  const copy = await generateCheckinCopy(task, en);
  assert.equal(provider.calls[0]?.background, true, "runs in the background LLM queue");
  assert.equal(copy.firstStep, "Open the problem set");
  const start = copy.messages.FUNNY?.START as CopyMessage;
  assert.equal(start.source, "LLM");
  assert.equal(start.hasFirstStep, true);
  assert.equal(copy.messages.GENTLE?.COMPLETION.source, "LLM");
});

test("copy: an LLM message that fails validation falls back to its template; the rest stay LLM", async () => {
  setAi(new AiService([new MockProvider({ ...llmReply, style: { ...llmReply.style, followup: "Physics assignment again? Don't be lazy." } })]));
  const copy = await generateCheckinCopy(task, en);
  assert.equal(copy.messages.FUNNY?.START_FOLLOWUP.source, "TEMPLATE");
  assert.equal(copy.messages.FUNNY?.START.source, "LLM");
  // Garbage JSON → everything from templates.
  setAi(new AiService([new MockProvider({ nope: true })]));
  const fallback = await generateCheckinCopy(task, en);
  assert.ok(KINDS.every((k) => fallback.messages.FUNNY?.[k].source === "TEMPLATE"));
});

test("copy: stale after rescheduling, a language change or a style change", () => {
  const copy = templateCopy(task, en);
  assert.equal(isCopyStale(copy, task, en), false);
  assert.equal(isCopyStale(copy, { scheduledStart: new Date("2026-10-06T11:00:00Z") }, en), true);
  assert.equal(isCopyStale(copy, task, ur), true);
  assert.equal(isCopyStale(copy, task, { language: "en", checkinTone: "SERIOUS" }), true);
  assert.equal(isCopyStale(null, task, en), true);
});

test("copy: research mode can omit the first step", async () => {
  setAi(new AiService([new MockProvider(llmReply)]));
  const copy = await generateCheckinCopy(task, en);
  const without = messageFor(copy, "START", "FUNNY", task, false);
  assert.equal(without.hasFirstStep, false);
  assert.doesNotMatch(without.text, /problem set/);
  assert.equal(renderTemplate("START", "SERIOUS", "en", task, "Open Q1").hasFirstStep, true);
});

test("copy: stored when a task gets a scheduled start and replaced after rescheduling", { skip: !dbAvailable && "no database" }, async () => {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `copy-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: "Asia/Karachi" } });
  const copyOf = async (id: string, slot: Date) => {
    for (let i = 0; i < 50; i += 1) {
      const t = await prisma.task.findUnique({ where: { id }, select: { checkinCopy: true } });
      const c = t?.checkinCopy as { slotStart?: string } | null;
      if (c?.slotStart === slot.toISOString()) return c;
      await new Promise((r) => setTimeout(r, 20));
    }
    return null;
  };
  try {
    const ctx = { userId: user.id, tz: "Asia/Karachi" };
    const first = new Date("2026-10-05T11:00:00Z");
    const t = await createTask(ctx, { title: "Physics assignment", priority: Priority.MEDIUM, source: TaskSource.CHAT, taskType: TaskType.FLEXIBLE, durationMinutes: 120, scheduledStart: first });
    assert.ok(await copyOf(t.id, first), "template copy stored for the first slot");
    const second = new Date("2026-10-06T11:00:00Z");
    await updateTask(ctx, t.id, { scheduledStart: second });
    assert.ok(await copyOf(t.id, second), "copy rewritten for the new slot");
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test.after(() => prisma.$disconnect());
