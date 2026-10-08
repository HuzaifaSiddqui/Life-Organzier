import { z } from "zod";
import type { Prisma, Task, UserSettings } from "@prisma/client";
import { getAi } from "../../ai/llm.js";
import { prisma } from "../../config/db.js";
import { formatDuration } from "../../lib/text.js";
import { ACK_TEMPLATES, TEMPLATES, type CopyKind, type Lang, type Tone } from "./templates.js";

/**
 * FR-RN-004 check-in copy. Messages are written ahead of time — templates immediately when a task
 * gets a scheduled start, then improved by the LLM in the background queue. Nothing is generated
 * at notification time.
 */

export const COPY_KINDS: CopyKind[] = ["START", "START_FOLLOWUP", "COMPLETION", "COMPLETION_UNCONFIRMED"];
export const MAX_MESSAGE_CHARS = 120;
const MAX_TITLE_CHARS = 40;

export type CopyMessage = { text: string; source: "LLM" | "TEMPLATE"; hasFirstStep: boolean };
export type CheckinCopy = {
  v: 1;
  /** The scheduledStart this copy was written for (ISO); a different start makes it stale. */
  slotStart: string;
  language: Lang;
  /** The user's saved style when written; GENTLE copy is always included for the mood exception. */
  savedTone: Tone;
  firstStep: string | null;
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

/* ---------------------------------------------------------------------------- validation */

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

/** Checks one LLM message: length, language, banned words, ≤ 1 emoji, mentions the task or first step. */
export function validateCheckinMessage(text: string, ctx: { language: Lang; title: string; firstStep: string | null }): ValidationResult {
  const t = text.trim();
  if (!t) return { ok: false, reason: "empty" };
  if (t.length > MAX_MESSAGE_CHARS) return { ok: false, reason: "too_long" };
  if (BANNED.some((re) => re.test(t))) return { ok: false, reason: "banned_word" };
  if ((t.match(EMOJI) ?? []).length > 1) return { ok: false, reason: "too_many_emoji" };
  const lower = t.toLowerCase();
  const mentions = [shortTitle(ctx.title), ctx.firstStep ?? ""].some((s) => s && lower.includes(s.toLowerCase().slice(0, 24)));
  if (!mentions) return { ok: false, reason: "no_task_or_step" };
  // Language check ignores the task title and first step (they may be in either language).
  let rest = t;
  for (const s of [shortTitle(ctx.title), ctx.firstStep ?? ""]) if (s) rest = rest.split(s).join(" ");
  const arabic = (rest.match(ARABIC) ?? []).length;
  const latin = (rest.match(LATIN_WORD) ?? []).length;
  if (ctx.language === "ur" && (arabic < 6 || latin > 2)) return { ok: false, reason: "wrong_language" };
  if (ctx.language === "en" && arabic > 0) return { ok: false, reason: "wrong_language" };
  return { ok: true };
}

export function validateFirstStep(step: string, language: Lang): boolean {
  const s = step.trim();
  if (s.length < 3 || s.length > 60 || BANNED.some((re) => re.test(s))) return false;
  return !(language === "en" && /[\u0600-\u06FF]/.test(s));
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

/** Stable pick per task + kind, so the same task doesn't change wording on every re-plan. */
function stableIndex(seed: string, n: number): number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return Math.abs(h) % n;
}

export function renderTemplate(
  kind: CopyKind,
  tone: Tone,
  lang: Lang,
  task: TaskForCopy,
  firstStep: string | null,
): CopyMessage {
  const all = TEMPLATES[lang][tone][kind];
  const withStep = all.filter((t) => t.includes("{firstStep}"));
  const withoutStep = all.filter((t) => !t.includes("{firstStep}"));
  const pool = firstStep && withStep.length ? withStep : withoutStep;
  const template = pool[stableIndex(`${task.id}:${kind}:${tone}`, pool.length)];
  const slots = { task: shortTitle(task.title), duration: durationLabel(task.durationMinutes, lang), firstStep: firstStep ?? "" };
  let text = fill(template, slots);
  // A long first step can push a template over the limit; fall back to one without it.
  if (text.length > MAX_MESSAGE_CHARS && firstStep) return renderTemplate(kind, tone, lang, task, null);
  if (text.length > MAX_MESSAGE_CHARS) text = `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…`;
  return { text, source: "TEMPLATE", hasFirstStep: Boolean(firstStep) && template.includes("{firstStep}") };
}

export function renderAck(kind: keyof (typeof ACK_TEMPLATES)["en"], lang: Lang, task: TaskForCopy, deadline = ""): string {
  const list = ACK_TEMPLATES[lang][kind];
  return fill(list[stableIndex(`${task.id}:${kind}`, list.length)], { task: shortTitle(task.title), deadline });
}

function tonesFor(saved: Tone): Tone[] {
  return saved === "GENTLE" ? ["GENTLE"] : [saved, "GENTLE"];
}

/** Template copy for every kind, in the saved style and Gentle. Instant, no I/O. */
export function templateCopy(task: TaskForCopy, settings: SettingsForCopy, now = new Date()): CheckinCopy {
  const lang = copyLanguage(settings.language);
  const saved = savedTone(settings.checkinTone);
  const messages: CheckinCopy["messages"] = {};
  for (const tone of tonesFor(saved)) {
    messages[tone] = Object.fromEntries(COPY_KINDS.map((k) => [k, renderTemplate(k, tone, lang, task, null)])) as Record<CopyKind, CopyMessage>;
  }
  return { v: 1, slotStart: (task.scheduledStart as Date).toISOString(), language: lang, savedTone: saved, firstStep: null, messages, generatedAt: now.toISOString() };
}

/** Copy is stale when the slot, language or saved style changed since it was written. */
export function isCopyStale(copy: unknown, task: Pick<Task, "scheduledStart">, settings: SettingsForCopy): boolean {
  const c = copy as Partial<CheckinCopy> | null;
  if (!c || c.v !== 1 || !task.scheduledStart) return true;
  return c.slotStart !== task.scheduledStart.toISOString() || c.language !== copyLanguage(settings.language) || c.savedTone !== savedTone(settings.checkinTone);
}

/* ---------------------------------------------------------------------------- LLM */

const messageSet = z.object({ start: z.string(), followup: z.string(), completion: z.string(), completionUnconfirmed: z.string() });
const llmSchema = z.object({ firstStep: z.string(), style: messageSet, gentle: messageSet });
const SET_JSON = {
  type: "object",
  properties: { start: { type: "string" }, followup: { type: "string" }, completion: { type: "string" }, completionUnconfirmed: { type: "string" } },
  required: ["start", "followup", "completion", "completionUnconfirmed"],
};
const LLM_JSON = { type: "object", properties: { firstStep: { type: "string" }, style: SET_JSON, gentle: SET_JSON }, required: ["firstStep", "style", "gentle"] };

const STYLE_GUIDE: Record<Tone, string> = {
  FUNNY: "light and playful; joke about the task itself, never about the user",
  SERIOUS: "direct and calm, no jokes",
  GENTLE: "soft and reassuring, no jokes; in start and followup, offer to split the task into smaller steps",
};

function prompt(task: TaskForCopy, lang: Lang, saved: Tone): string {
  return `You write short phone notifications for a productivity app.
Task: "${shortTitle(task.title)}". Planned duration: ${durationLabel(task.durationMinutes, "en")}.
Return JSON: firstStep (the smallest concrete first action for this task, max 8 words), and two message sets "style" and "gentle", each with:
- start: asks if they have started; include the first step
- followup: second, shorter nudge 25 minutes later; include the first step
- completion: asks if the task is done after the planned time
- completionUnconfirmed: softer "how did it go?" for when they never confirmed starting
"style" tone: ${STYLE_GUIDE[saved]}. "gentle" tone: ${STYLE_GUIDE.GENTLE}.
Rules: every message under 110 characters; write in ${lang === "ur" ? "Urdu (Urdu script)" : "English"}; mention the task title exactly as given; no guilt, shaming or comparisons; never use the words lazy, failure, again?, disappointed; at most one emoji.`;
}

/**
 * Builds copy with the LLM, validating every message; any message that fails validation (or all
 * of them, if the model is down) falls back to its template. Never throws.
 */
export async function generateCheckinCopy(task: TaskForCopy, settings: SettingsForCopy, now = new Date()): Promise<CheckinCopy> {
  const base = templateCopy(task, settings, now);
  const lang = base.language;
  const ai = getAi();
  if (!ai.enabled) return base;
  const result = await ai.json([{ role: "user", content: prompt(task, lang, base.savedTone) }], llmSchema, {
    json: LLM_JSON,
    background: true,
    maxTokens: 500,
    temperature: 0.7,
    timeoutMs: 60000,
  });
  if (!result) return base;
  const firstStep = validateFirstStep(result.firstStep, lang) ? result.firstStep.trim() : null;
  const sets: Record<Tone, z.infer<typeof messageSet>> = { [base.savedTone]: result.style, GENTLE: result.gentle } as Record<Tone, z.infer<typeof messageSet>>;
  const keyOf: Record<CopyKind, keyof z.infer<typeof messageSet>> = { START: "start", START_FOLLOWUP: "followup", COMPLETION: "completion", COMPLETION_UNCONFIRMED: "completionUnconfirmed" };
  const messages: CheckinCopy["messages"] = {};
  for (const tone of tonesFor(base.savedTone)) {
    messages[tone] = Object.fromEntries(
      COPY_KINDS.map((k) => {
        const text = sets[tone][keyOf[k]].trim();
        const valid = validateCheckinMessage(text, { language: lang, title: task.title, firstStep });
        const needsStep = k === "START" || k === "START_FOLLOWUP";
        if (!valid.ok) return [k, renderTemplate(k, tone, lang, task, needsStep ? firstStep : null)];
        return [k, { text, source: "LLM", hasFirstStep: Boolean(firstStep && text.toLowerCase().includes(firstStep.toLowerCase().slice(0, 24))) }];
      }),
    ) as Record<CopyKind, CopyMessage>;
  }
  return { ...base, firstStep, messages };
}

/**
 * Message for one check-in. `includeFirstStep: false` (research mode) uses the template without a
 * first step so both variants can be compared.
 */
export function messageFor(copy: CheckinCopy, kind: CopyKind, tone: Tone, task: TaskForCopy, includeFirstStep = true): CopyMessage {
  const set = copy.messages[tone] ?? copy.messages.GENTLE;
  const msg = set?.[kind];
  if (!includeFirstStep && msg?.hasFirstStep) return renderTemplate(kind, tone, copy.language, task, null);
  return msg ?? renderTemplate(kind, tone, copy.language, task, includeFirstStep ? copy.firstStep : null);
}

/* ---------------------------------------------------------------------------- persistence */

/**
 * Called when a task's scheduledStart is set or changed: stores template copy immediately (so a
 * check-in always has a message), then queues LLM copy in the background and stores it only if the
 * slot is still the same. Never blocks the caller.
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
      await save(await generateCheckinCopy(task, settings));
    } catch (error) {
      console.warn("Check-in copy generation failed", error instanceof Error ? error.message : error);
    }
  })();
}
