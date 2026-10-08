import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Priority, TaskSource, TaskType } from "@prisma/client";
import { AiService, setAi, type ChatMessage, type CompletionOptions, type LlmProvider } from "../src/ai/llm.js";
import {
  FIRST_STEP_VERBS,
  findFirstStep,
  generateCheckinCopy,
  isCopyStale,
  libraryFirstStep,
  messageFor,
  renderTemplate,
  templateCopy,
  validateCheckinMessage,
  validateFirstStep,
  visibleLength,
} from "../src/modules/checkins/copy.js";
import { ACK_TEMPLATES, FIRST_STEP_LIBRARY, TEMPLATES, type CopyKind, type Lang, type Tone } from "../src/modules/checkins/templates.js";
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
const ISO = (t: string, lang: Lang) => (lang === "ur" ? `⁨${t}⁩` : t);

class MockProvider implements LlmProvider {
  calls: CompletionOptions[] = [];
  constructor(
    readonly name: string,
    private readonly reply: unknown,
  ) {}
  async chat(_m: ChatMessage[], options: CompletionOptions): Promise<string> {
    this.calls.push(options);
    if (this.reply instanceof Error) throw this.reply;
    return JSON.stringify(this.reply);
  }
}

/* ------------------------------------------------------------------ templates */

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
            .replace("{task}", ISO(task.title, lang))
            .replace("{duration}", lang === "en" ? "2 hours" : "2 گھنٹے")
            .replace("{firstStep}", firstStep ?? "");
          assert.ok(visibleLength(text) <= 120, `${lang}/${tone}/${kind}#${i} is ${visibleLength(text)} chars: ${text}`);
          const v = validateCheckinMessage(text, { language: lang, title: task.title, firstStep });
          assert.ok(v.ok, `${lang}/${tone}/${kind}#${i}: ${JSON.stringify(v)} — ${text}`);
        }
  for (const lang of LANGS) for (const list of Object.values(ACK_TEMPLATES[lang])) for (const t of list) assert.ok(t.length <= 120);
});

test("templates: rendering always fits 120 visible chars, even with the longest title and a 60-char first step", () => {
  const step = { en: "Open the slide deck and outline the first three main sections", ur: "پریزنٹیشن کھولیں اور پہلے تین حصوں کا خاکہ بنائیں تاکہ آغاز آسان ہو" };
  for (const lang of LANGS)
    for (const tone of TONES)
      for (const kind of KINDS)
        for (const id of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
          const t = { ...long, id };
          const m = renderTemplate(kind, tone, lang, t, step[lang].slice(0, 60));
          assert.ok(visibleLength(m.text) <= 120, `${lang}/${tone}/${kind}: ${visibleLength(m.text)} — ${m.text}`);
          assert.ok(validateCheckinMessage(m.text, { language: lang, title: t.title, firstStep: m.hasFirstStep ? step[lang].slice(0, 60) : null }).ok, m.text);
        }
});

test("templates: Urdu wraps the task title in directional isolates that don't count toward the limit", () => {
  const urMsg = renderTemplate("COMPLETION", "SERIOUS", "ur", task, null).text;
  assert.ok(urMsg.includes(`⁨${task.title}⁩`), urMsg);
  assert.equal(visibleLength(urMsg), urMsg.length - 2);
  assert.ok(!renderTemplate("COMPLETION", "SERIOUS", "en", task, null).text.includes("⁨"));
  // 119 visible chars + 2 isolates must still be accepted.
  const padded = `⁨${task.title}⁩ ${"ب".repeat(119 - task.title.length - 1)}`;
  assert.equal(visibleLength(padded), 119);
  assert.notDeepEqual(validateCheckinMessage(padded, { language: "ur", title: task.title, firstStep: null }), { ok: false, reason: "too_long" });
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
  assert.deepEqual(validateCheckinMessage(`Physics assignment ${"x".repeat(110)}`, ctx), { ok: false, reason: "too_long" });
  for (const bad of ["Physics assignment — don't be lazy", "Physics assignment again?", "I'm disappointed about Physics assignment"]) {
    assert.deepEqual(validateCheckinMessage(bad, ctx), { ok: false, reason: "banned_word" }, bad);
  }
  assert.deepEqual(validateCheckinMessage("Physics assignment 🚀🔥 go!", ctx), { ok: false, reason: "too_many_emoji" });
  assert.deepEqual(validateCheckinMessage("Time to start your task. Ready?", ctx), { ok: false, reason: "no_task_or_step" });
  assert.deepEqual(validateCheckinMessage("Physics assignment شروع کریں", ctx), { ok: false, reason: "wrong_language" });
});

/* ------------------------------------------------------------------ first step */

test("first step: strict validation of model output (incl. the bad qwen examples)", () => {
  const ok = (s: string, lang: Lang = "en", title = task.title) => validateFirstStep(s, lang, title);
  assert.equal(ok("Open the problem set"), true);
  assert.equal(ok("Review your lecture notes."), true, "trailing full stop is tolerated");
  assert.equal(ok("Read chapter 3 intro", "en", "Chapter 3 exercises"), true, "digit from the title is fine");
  assert.equal(ok("سوالات کا پہلا صفحہ کھولیں", "ur"), true);
  assert.equal(ok("Physics assignment کی فائل کھولیں", "ur"), true, "English title inside Urdu is fine");
  assert.equal(ok("Reproduce the login error locally", "en", "Fix the login bug in the FYP app"), true, "real Gemini output");
  assert.equal(ok("فزکس کی کتاب اور کاپی کھولیں", "ur"), true, "real Gemini Urdu output");
  assert.equal(ok("Remove clothes from floor", "en", "Clean my room"), true);
  assert.equal(ok("log in to LeetCode", "en", "Practice DSA problems"), true);

  assert.equal(ok("for physics success, 2 hours"), false, "qwen: comma, digit, no verb");
  assert.equal(ok("Let's into smaller steps"), false, "qwen: not an imperative from the allowlist");
  assert.equal(ok("فیزیک کی کامیابی کے لئے 2 گھنٹے", "ur"), false, "qwen Urdu: digit");
  assert.equal(ok("Review notes first. Then the summary; done"), false, "semicolon");
  assert.equal(ok("Open the problem set 🚀"), false, "emoji");
  assert.equal(ok("Solve question 3"), false, "digit not in title");
  assert.equal(ok("Start the physics assignment"), false, "just the title repeated");
  assert.equal(ok("Physics assignment"), false);
  assert.equal(ok("Open"), false, "one word");
  assert.equal(ok("Open the book and read the first two pages slowly please"), false, "> 8 words");
  assert.equal(ok("Open the notes", "ur"), false, "English for an Urdu user");
  assert.equal(ok("نوٹس کھولیں", "en"), false, "Urdu for an English user");
  assert.equal(ok("Stop being lazy and start"), false, "banned word / no allowlisted verb");
});

test("first step: keyword library has ≥ 12 groups of imperative English and Urdu-script steps", () => {
  assert.ok(FIRST_STEP_LIBRARY.length >= 12);
  for (const g of FIRST_STEP_LIBRARY) {
    assert.ok(FIRST_STEP_VERBS.has(g.en.split(" ")[0].toLowerCase()), g.en);
    assert.match(g.ur, /^[؀-ۿ\s]+$/, g.ur);
  }
  assert.equal(libraryFirstStep("Write the history essay", "en"), "Open the document and write the first heading");
  assert.equal(libraryFirstStep("Physics assignment", "en"), "Read question 1");
  assert.equal(libraryFirstStep("Revise for the maths exam", "ur"), "اپنے نوٹس پہلے موضوع سے کھولیں");
  assert.equal(libraryFirstStep("Ammi ki dawai lena", "en"), null);
});

test("first step: Gemini first, then Ollama (English only), then library, then none", async () => {
  const good = { firstStep: "Open the problem set" };
  const bad = { firstStep: "Let's into smaller steps" };

  let gemini = new MockProvider("gemini", good);
  let ollama = new MockProvider("ollama", { firstStep: "Review the lecture slides" });
  setAi(new AiService([gemini, ollama]));
  assert.deepEqual(await findFirstStep(task, "en"), { step: "Open the problem set", source: "GEMINI" });
  assert.deepEqual(gemini.calls[0].providers, ["gemini"], "per-call provider preference");
  assert.equal(gemini.calls[0].background, true, "background queue");
  assert.equal(ollama.calls.length, 0);

  gemini = new MockProvider("gemini", bad);
  ollama = new MockProvider("ollama", { firstStep: "Review the lecture slides" });
  setAi(new AiService([gemini, ollama]));
  assert.deepEqual(await findFirstStep(task, "en"), { step: "Review the lecture slides", source: "OLLAMA" });

  // Urdu never goes to Ollama.
  gemini = new MockProvider("gemini", bad);
  ollama = new MockProvider("ollama", { firstStep: "سوالات کھولیں" });
  setAi(new AiService([gemini, ollama]));
  assert.deepEqual(await findFirstStep(task, "ur"), { step: "پہلا سوال پڑھیں", source: "LIBRARY" });
  assert.equal(ollama.calls.length, 0);

  setAi(new AiService([]));
  assert.deepEqual(await findFirstStep({ ...task, title: "Ammi ki dawai lena" }, "en"), { step: null, source: "NONE" });
});

test("first step: a failing provider trips the circuit breaker and the next source is used", async () => {
  const gemini = new MockProvider("gemini", new Error("HTTP 503"));
  const ai = new AiService([gemini]);
  setAi(ai);
  assert.deepEqual(await findFirstStep(task, "en"), { step: "Read question 1", source: "LIBRARY" });
  assert.equal(ai.hasProvider("gemini"), false);
  await findFirstStep(task, "en");
  assert.equal(gemini.calls.length, 1, "skipped while the breaker is open");
});

/* ------------------------------------------------------------------ copy */

test("copy: AI unavailable → template messages with the library step; check-in still has a message", async () => {
  setAi(new AiService([]));
  const copy = await generateCheckinCopy(task, en);
  assert.equal(copy.savedTone, "FUNNY", "new users default to Funny");
  assert.equal(copy.firstStepSource, "LIBRARY");
  assert.deepEqual(Object.keys(copy.messages).sort(), ["FUNNY", "GENTLE"]);
  assert.match(messageFor(copy, "COMPLETION", "FUNNY", task).text, /Physics assignment/);
  const none = await generateCheckinCopy({ ...task, title: "Ammi ki dawai lena" }, en);
  assert.equal(none.firstStepSource, "NONE");
  assert.ok(KINDS.every((k) => !none.messages.FUNNY?.[k].hasFirstStep));
  assert.deepEqual(Object.keys(templateCopy(task, { language: "en", checkinTone: "GENTLE" }).messages), ["GENTLE"]);
  assert.match(templateCopy(task, ur).messages.FUNNY!.START.text, /[؀-ۿ]/);
});

test("copy: message text always comes from templates; only the first step is model-written", async () => {
  setAi(new AiService([new MockProvider("gemini", { firstStep: "Open the problem set" })]));
  const copy = await generateCheckinCopy(task, en);
  assert.equal(copy.firstStepSource, "GEMINI");
  const start = copy.messages.FUNNY!.START;
  assert.equal(start.hasFirstStep, true);
  const fromTemplate = TEMPLATES.en.FUNNY.START.map((t) => t.replace("{task}", task.title).replace("{firstStep}", "Open the problem set").replace("{duration}", "2 hours"));
  assert.ok(fromTemplate.includes(start.text), start.text);
});

test("copy: stale after rescheduling, a language change, a style change or an old format", () => {
  const copy = templateCopy(task, en);
  assert.equal(isCopyStale(copy, task, en), false);
  assert.equal(isCopyStale(copy, { scheduledStart: new Date("2026-10-06T11:00:00Z") }, en), true);
  assert.equal(isCopyStale(copy, task, ur), true);
  assert.equal(isCopyStale(copy, task, { language: "en", checkinTone: "SERIOUS" }), true);
  assert.equal(isCopyStale({ ...copy, v: 1 }, task, en), true);
  assert.equal(isCopyStale(null, task, en), true);
});

test("copy: research mode can omit the first step", () => {
  const copy = templateCopy(task, en);
  const without = messageFor(copy, "START", "FUNNY", task, false);
  assert.equal(without.hasFirstStep, false);
  assert.doesNotMatch(without.text, /question 1/);
  assert.equal(messageFor(copy, "START", "FUNNY", task, true).hasFirstStep, true);
});

test("copy: stored when a task gets a scheduled start and replaced after rescheduling", { skip: !dbAvailable && "no database" }, async () => {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `copy-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: "Asia/Karachi" } });
  const copyOf = async (id: string, slot: Date) => {
    for (let i = 0; i < 50; i += 1) {
      const t = await prisma.task.findUnique({ where: { id }, select: { checkinCopy: true } });
      const c = t?.checkinCopy as { slotStart?: string; firstStepSource?: string } | null;
      if (c?.slotStart === slot.toISOString()) return c;
      await new Promise((r) => setTimeout(r, 20));
    }
    return null;
  };
  try {
    const ctx = { userId: user.id, tz: "Asia/Karachi" };
    const first = new Date("2026-10-05T11:00:00Z");
    const t = await createTask(ctx, { title: "Physics assignment", priority: Priority.MEDIUM, source: TaskSource.CHAT, taskType: TaskType.FLEXIBLE, durationMinutes: 120, scheduledStart: first });
    assert.equal((await copyOf(t.id, first))?.firstStepSource, "LIBRARY");
    const second = new Date("2026-10-06T11:00:00Z");
    await updateTask(ctx, t.id, { scheduledStart: second });
    assert.ok(await copyOf(t.id, second), "copy rewritten for the new slot");
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test.after(() => prisma.$disconnect());
