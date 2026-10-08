import { z } from "zod";
import type { Prisma, Task, UserSettings } from "@prisma/client";
import { getAi } from "../../ai/llm.js";
import { prisma } from "../../config/db.js";
import { formatDuration } from "../../lib/text.js";
import { ACK_TEMPLATES, FIRST_STEP_LIBRARY, TEMPLATES, type CopyKind, type Lang, type Tone } from "./templates.js";

/**
 * FR-RN-004 check-in copy. Message text always comes from the reviewed templates; only the first
 * step is model-written (Gemini, then Ollama for English), else taken from the keyword library.
 * Copy is written ahead of time — nothing is generated at notification time.
 */

export const COPY_KINDS: CopyKind[] = ["START", "START_FOLLOWUP", "COMPLETION", "COMPLETION_UNCONFIRMED"];
export const MAX_MESSAGE_CHARS = 120;
const MAX_TITLE_CHARS = 40;
/** Unicode first-strong isolate: keeps an English title left-to-right inside Urdu text. */
const FSI = "⁨";
const PDI = "⁩";

/** Where the first step came from; stored as CheckinLog.copySource for the evaluation. */
export type FirstStepSource = "GEMINI" | "OLLAMA" | "LIBRARY" | "NONE";
export type CopyMessage = { text: string; hasFirstStep: boolean };
export type CheckinCopy = {
  v: 2;
  /** The scheduledStart this copy was written for (ISO); a different start makes it stale. */
  slotStart: string;
  language: Lang;
  /** The user's saved style when written; GENTLE copy is always included for the mood exception. */
  savedTone: Tone;
  firstStep: string | null;
  firstStepSource: FirstStepSource;
  messages: Partial<Record<Tone, Record<CopyKind, CopyMessage>>>;
  generatedAt: string;
};

type TaskForCopy = Pick<Task, "id" | "title" | "durationMinutes" | "scheduledStart">;
type SettingsForCopy = Pick<UserSettings, "language" | "checkinTone">;

export function copyLanguage(language: string | null | undefined): Lang {
  return language === "ur" ? "ur" : "en";
}

function savedTone(value: string): Tone {
  return value === "SERIOUS" || value === "GENTLE" ? value : "FUNNY";
}

/** Characters the user sees: directional isolates don't count toward the 120-char limit. */
export function visibleLength(text: string): number {
  return text.replace(/[⁦-⁩]/g, "").length;
}

/* ---------------------------------------------------------------------------- message validation (templates) */

const ARABIC = /[؀-ۿ]/g;
const LATIN_WORD = /[A-Za-z]{3,}/g;
const EMOJI = /\p{Extended_Pictographic}/gu;
/** Guilt, shaming and failure words (FR-RN-004 §5). English, Roman Urdu and Urdu. */
const BANNED = [
  /\blazy\b/i,
  /\bfail(?:ure|ed|ing)?\b/i,
  /\bagain\s*\?/i,
  /\bdisappoint\w*/i,
  /\bshame\w*\b/i,
  /\bpathetic\b/i,
  /\buseless\b/i,
  /\bexcuses?\b/i,
  /\bprocrastinat\w*/i,
  /\bshould have\b/i,
  /\bwhy haven'?t you\b/i,
  /\bunlike (?:others|everyone)\b/i,
  /\b(?:kaamchor|nikamm[ae]|sust)\b/i,
  /سست|ناکام|شرم|مایوس|نکما|کام چور|پھر سے؟/,
];

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/** Checks a rendered message: length, language, banned words, ≤ 1 emoji, mentions the task or first step. */
export function validateCheckinMessage(text: string, ctx: { language: Lang; title: string; firstStep: string | null }): ValidationResult {
  const t = text.trim();
  if (!t) return { ok: false, reason: "empty" };
  if (visibleLength(t) > MAX_MESSAGE_CHARS) return { ok: false, reason: "too_long" };
  if (BANNED.some((re) => re.test(t))) return { ok: false, reason: "banned_word" };
  if ((t.match(EMOJI) ?? []).length > 1) return { ok: false, reason: "too_many_emoji" };
  const lower = t.toLowerCase();
  const mentions = [shortTitle(ctx.title), ctx.firstStep ?? ""].some((s) => s && lower.includes(s.toLowerCase().slice(0, 24)));
  if (!mentions) return { ok: false, reason: "no_task_or_step" };
  let rest = t;
  for (const s of [shortTitle(ctx.title), ctx.firstStep ?? ""]) if (s) rest = rest.split(s).join(" ");
  const arabic = (rest.match(ARABIC) ?? []).length;
  const latin = (rest.match(LATIN_WORD) ?? []).length;
  if (ctx.language === "ur" && (arabic < 6 || latin > 2)) return { ok: false, reason: "wrong_language" };
  if (ctx.language === "en" && arabic > 0) return { ok: false, reason: "wrong_language" };
  return { ok: true };
}

/* ---------------------------------------------------------------------------- first-step validation (LLM output) */

/** Imperative verbs an English first step may start with. */
export const FIRST_STEP_VERBS = new Set([
  "open", "read", "write", "draft", "list", "outline", "sketch", "review", "skim", "find", "search", "look", "check",
  "gather", "collect", "pick", "choose", "select", "start", "begin", "set", "make", "create", "add", "type", "note",
  "jot", "copy", "download", "install", "run", "test", "fix", "solve", "answer", "attempt", "try", "plan", "sort",
  "clear", "put", "get", "grab", "take", "watch", "listen", "call", "dial", "text", "email", "message", "reply",
  "send", "fill", "book", "pay", "print", "highlight", "summarize", "summarise", "label", "measure", "prepare",
  "practice", "practise", "revise", "memorize", "define", "compare", "calculate", "reproduce", "debug",
  "research", "identify", "locate", "explore", "brainstorm", "recall", "organize", "organise",
]);

/**
 * Strict check for a model-written first step: 2–8 words; English starts with an allowlisted
 * imperative verb; no digits unless in the title; no commas, semicolons or emoji; not just the
 * title repeated; Urdu is Urdu script apart from the task title.
 */
export function validateFirstStep(step: string, language: Lang, title: string): boolean {
  const s = step.trim().replace(/[.!۔]+$/, "").trim();
  if (!s || /[,;،؛]/.test(s) || /\p{Extended_Pictographic}/u.test(s)) return false;
  if (BANNED.some((re) => re.test(s))) return false;
  const digits = s.match(/[0-9۰-۹٠-٩]+/g) ?? [];
  if (digits.some((d) => !title.includes(d))) return false;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 8) return false;
  const titleWords = new Set(title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  if (language === "en") {
    if (/[؀-ۿ]/.test(s)) return false;
    if (!FIRST_STEP_VERBS.has(words[0].toLowerCase())) return false;
    // "Start the physics assignment" adds nothing beyond the title.
    const rest = words.slice(1).map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")).filter((w) => w && !["the", "a", "an", "your", "my", "on", "with"].includes(w));
    if (rest.length && rest.every((w) => titleWords.has(w))) return false;
  } else {
    const withoutTitle = s.split(title).join(" ");
    if (/[A-Za-z]/.test(withoutTitle) || !/[؀-ۿ]/.test(withoutTitle)) return false;
  }
  return s.toLowerCase() !== title.trim().toLowerCase();
}

/** First step from the reviewed keyword library (null when no group matches). */
export function libraryFirstStep(title: string, language: Lang): string | null {
  const hit = FIRST_STEP_LIBRARY.find((g) => g.keywords.test(title));
  return hit ? hit[language] : null;
}

/* ---------------------------------------------------------------------------- templates */

export function shortTitle(title: string): string {
  const t = title.trim().replace(/\s+/g, " ");
  return t.length <= MAX_TITLE_CHARS ? t : `${t.slice(0, MAX_TITLE_CHARS - 1).replace(/\s+\S*$/, "")}…`;
}

export function durationLabel(minutes: number | null, lang: Lang): string {
  if (!minutes) return lang === "ur" ? "مقررہ وقت" : "planned time";
  if (lang === "en") return formatDuration(minutes);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} ${h === 1 ? "گھنٹہ" : "گھنٹے"}` : "", m ? `${m} منٹ` : ""].filter(Boolean).join(" ");
}

function fill(template: string, slots: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => slots[k] ?? "");
}

/** Title slot: shortened, and isolated in Urdu so an English title renders left-to-right. */
function taskSlot(title: string, lang: Lang): string {
  const t = shortTitle(title);
  return lang === "ur" ? `${FSI}${t}${PDI}` : t;
}

/** Stable pick per task + kind, so the same task doesn't change wording on every re-plan. */
function stableIndex(seed: string, n: number): number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return Math.abs(h) % n;
}

export function renderTemplate(kind: CopyKind, tone: Tone, lang: Lang, task: TaskForCopy, firstStep: string | null): CopyMessage {
  const all = TEMPLATES[lang][tone][kind];
  const withStep = all.filter((t) => t.includes("{firstStep}"));
  const withoutStep = all.filter((t) => !t.includes("{firstStep}"));
  const pool = firstStep && withStep.length ? withStep : withoutStep;
  const template = pool[stableIndex(`${task.id}:${kind}:${tone}`, pool.length)];
  let text = fill(template, { task: taskSlot(task.title, lang), duration: durationLabel(task.durationMinutes, lang), firstStep: firstStep ?? "" });
  // A long first step can push a template over the limit; fall back to one without it.
  if (visibleLength(text) > MAX_MESSAGE_CHARS && firstStep) return renderTemplate(kind, tone, lang, task, null);
  if (visibleLength(text) > MAX_MESSAGE_CHARS) text = `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…`;
  return { text, hasFirstStep: Boolean(firstStep) && template.includes("{firstStep}") };
}

export function renderAck(kind: keyof (typeof ACK_TEMPLATES)["en"], lang: Lang, task: TaskForCopy, deadline = ""): string {
  const list = ACK_TEMPLATES[lang][kind];
  return fill(list[stableIndex(`${task.id}:${kind}`, list.length)], { task: taskSlot(task.title, lang), deadline });
}

function tonesFor(saved: Tone): Tone[] {
  return saved === "GENTLE" ? ["GENTLE"] : [saved, "GENTLE"];
}

/** Template messages for every kind in the saved style and Gentle, around a given first step. */
export function buildCopy(task: TaskForCopy, settings: SettingsForCopy, firstStep: string | null, source: FirstStepSource, now = new Date()): CheckinCopy {
  const lang = copyLanguage(settings.language);
  const saved = savedTone(settings.checkinTone);
  const messages: CheckinCopy["messages"] = {};
  for (const tone of tonesFor(saved)) {
    messages[tone] = Object.fromEntries(
      COPY_KINDS.map((k) => [k, renderTemplate(k, tone, lang, task, k === "START" || k === "START_FOLLOWUP" ? firstStep : null)]),
    ) as Record<CopyKind, CopyMessage>;
  }
  return {
    v: 2,
    slotStart: (task.scheduledStart as Date).toISOString(),
    language: lang,
    savedTone: saved,
    firstStep,
    firstStepSource: firstStep ? source : "NONE",
    messages,
    generatedAt: now.toISOString(),
  };
}

/** Instant copy with the library first step (or none). No I/O. */
export function templateCopy(task: TaskForCopy, settings: SettingsForCopy, now = new Date()): CheckinCopy {
  const step = libraryFirstStep(task.title, copyLanguage(settings.language));
  return buildCopy(task, settings, step, step ? "LIBRARY" : "NONE", now);
}

/** Copy is stale when the slot, language or saved style changed since it was written (or it's an old format). */
export function isCopyStale(copy: unknown, task: Pick<Task, "scheduledStart">, settings: SettingsForCopy): boolean {
  const c = copy as Partial<CheckinCopy> | null;
  if (!c || c.v !== 2 || !task.scheduledStart) return true;
  return c.slotStart !== task.scheduledStart.toISOString() || c.language !== copyLanguage(settings.language) || c.savedTone !== savedTone(settings.checkinTone);
}

/* ---------------------------------------------------------------------------- model first step */

const stepSchema = z.object({ firstStep: z.string() });
const STEP_JSON = { type: "object", properties: { firstStep: { type: "string" } }, required: ["firstStep"] };

/**
 * Privacy: only the task title and duration are sent — never the description, notes, mood or any
 * user details (docs/AI_ASSISTANT_ARCHITECTURE.md).
 */
function stepPrompt(task: TaskForCopy, lang: Lang): string {
  const language = lang === "ur" ? "Urdu, in Urdu script" : "English, starting with an imperative verb";
  return `Task: "${shortTitle(task.title)}". Planned time: ${durationLabel(task.durationMinutes, "en")}.
Give the smallest concrete first action to start this task, 2 to 8 words, in ${language}.
No numbers, commas or emoji. Don't just repeat the task title. Return JSON {"firstStep": "..."}.`;
}

export async function modelFirstStep(provider: "gemini" | "ollama", task: TaskForCopy, lang: Lang): Promise<string | null> {
  const ai = getAi();
  if (!ai.hasProvider(provider)) return null;
  const result = await ai.json([{ role: "user", content: stepPrompt(task, lang) }], stepSchema, {
    json: STEP_JSON,
    providers: [provider],
    background: true,
    maxTokens: 60,
    temperature: 0.3,
    timeoutMs: 30000,
  });
  const step = result?.firstStep.trim().replace(/[.!۔]+$/, "").trim();
  return step && validateFirstStep(step, lang, task.title) ? step : null;
}

/**
 * First step in order: Gemini (English + Urdu), Ollama (English only), keyword library, none.
 * A source that is unavailable or fails validation passes to the next. Never throws.
 */
export async function findFirstStep(task: TaskForCopy, lang: Lang): Promise<{ step: string | null; source: FirstStepSource }> {
  const gemini = await modelFirstStep("gemini", task, lang).catch(() => null);
  if (gemini) return { step: gemini, source: "GEMINI" };
  if (lang === "en") {
    const ollama = await modelFirstStep("ollama", task, lang).catch(() => null);
    if (ollama) return { step: ollama, source: "OLLAMA" };
  }
  const library = libraryFirstStep(task.title, lang);
  return library ? { step: library, source: "LIBRARY" } : { step: null, source: "NONE" };
}

export async function generateCheckinCopy(task: TaskForCopy, settings: SettingsForCopy, now = new Date()): Promise<CheckinCopy> {
  const { step, source } = await findFirstStep(task, copyLanguage(settings.language));
  return buildCopy(task, settings, step, source, now);
}

/**
 * Message for one check-in. `includeFirstStep: false` (research mode) picks the template without a
 * first step so both variants can be compared.
 */
export function messageFor(copy: CheckinCopy, kind: CopyKind, tone: Tone, task: TaskForCopy, includeFirstStep = true): CopyMessage {
  const msg = (copy.messages[tone] ?? copy.messages.GENTLE)?.[kind];
  if (!includeFirstStep && msg?.hasFirstStep) return renderTemplate(kind, tone, copy.language, task, null);
  return msg ?? renderTemplate(kind, tone, copy.language, task, includeFirstStep ? copy.firstStep : null);
}

/* ---------------------------------------------------------------------------- persistence */

/**
 * Called when a task's scheduledStart is set or changed: stores library/template copy immediately
 * (so a check-in always has a message), then looks for a model first step in the background and
 * stores the result only if the slot is still the same. Never blocks the caller.
 */
export function refreshCheckinCopy(task: TaskForCopy & { userId: string }): void {
  void (async () => {
    try {
      if (!task.scheduledStart) return;
      const settings = await prisma.userSettings.findUnique({ where: { userId: task.userId }, select: { language: true, checkinTone: true, checkinsEnabled: true } });
      if (!settings?.checkinsEnabled) return;
      const save = (copy: CheckinCopy) =>
        prisma.task.updateMany({ where: { id: task.id, scheduledStart: task.scheduledStart }, data: { checkinCopy: copy as unknown as Prisma.InputJsonValue } });
      await save(templateCopy(task, settings));
      const better = await generateCheckinCopy(task, settings);
      if (better.firstStepSource === "GEMINI" || better.firstStepSource === "OLLAMA") await save(better);
    } catch (error) {
      console.warn("Check-in copy generation failed", error instanceof Error ? error.message : error);
    }
  })();
}
