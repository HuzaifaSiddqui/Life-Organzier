import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ZodType } from "zod";
import { maskForProvider } from "../lib/mask.js";
import { classifyProviderError, extractJson, OllamaProvider, type ChatMessage, type CompletionOptions, type LlmProvider } from "./llm.js";
import { makeProvider, providerKey, providerSpecs, type Tier } from "./providers.js";

/**
 * Hosted provider chains, one per job (chat, docs, vision). OFF unless LLM_PROVIDERS_<JOB> is set: without it the
 * AiService keeps its baseline chain (Ollama, AI_PROVIDER, GEMINI_FALLBACK) exactly as before.
 *
 * - Order: config/provider-order.json "chains" (a decision; the benchmark writes only its "ranking"), filtered to the providers named in
 *   LLM_PROVIDERS_<JOB>; Bedrock goes first when BEDROCK_ENABLED=true. A tier B provider never leads unless it is
 *   named in LLM_TIER_B_LEAD_APPROVED, never receives images, and every non-Ollama provider gets masked text only.
 * - Each call: 8 s (Ollama: what is left of the budget), one retry on a network error only; the whole chain has 15 s,
 *   then the caller falls back to the rules (null). Fail over on timeout, 429, 5xx, an empty reply and, for JSON
 *   jobs, unparseable or schema-failing JSON.
 * - Breaker: 3 failures in a row skip a provider for 60 s, then one probe call decides.
 * - Limits: per-provider counters per day (and per minute where the provider has a cap, e.g. OpenRouter 20/min,
 *   50/day); spend cap $0: an HTTP 402 or any reported cost turns the provider off for the rest of the day.
 * - Logs: provider, model, latency, status and token counts only (never prompts or keys).
 */

export type Job = "chat" | "docs" | "vision";
/** fewShot: this provider gets the router prompt with the nearest bank examples (set per provider in provider-order.json). */
type Entry = { provider: string; model: string; fewShot?: boolean };
type State = {
  name: string;
  model: string;
  tier: Tier;
  images: boolean;
  instance: LlmProvider;
  fewShot: boolean;
  failures: number;
  openUntil: number;
  probing: boolean;
  day: string;
  today: number;
  minute: number[];
  billingBlocked: boolean;
  lastStatus: string;
  lastAt: string | null;
};

const CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../config");
export const CALL_TIMEOUT_MS = 8000;
export const CHAIN_BUDGET_MS = 15000;
export const BREAKER_FAILURES = 3;
export const BREAKER_OPEN_MS = 60000;

const ENV: Record<Job, string> = { chat: "LLM_PROVIDERS_CHAT", docs: "LLM_PROVIDERS_DOCS", vision: "LLM_PROVIDERS_VISION" };

/**
 * CLOUD_FALLBACK=on (default off) is required for any hosted chain. Off: every model call takes the baseline path
 * (Ollama, as before), whatever LLM_PROVIDERS_* say. Masking hides numbers, e-mails, links and names after a cue; it
 * does not remove what a message is about, so turning this on sends the content of unclear messages to a cloud
 * provider (docs/providers.md → Cloud fallback).
 */
export function cloudFallbackOn(): boolean {
  return process.env.CLOUD_FALLBACK?.toLowerCase() === "on";
}

export function chainConfigured(job: Job): boolean {
  return cloudFallbackOn() && Boolean(process.env[ENV[job]]?.trim());
}

function readOrder(): Record<Job, Entry[]> {
  const file = join(CONFIG_DIR, "provider-order.json");
  if (!existsSync(file)) return { chat: [], docs: [], vision: [] };
  const data = JSON.parse(readFileSync(file, "utf8")) as { chains?: Partial<Record<Job, Entry[]>> };
  return { chat: data.chains?.chat ?? [], docs: data.chains?.docs ?? [], vision: data.chains?.vision ?? [] };
}

const isNetworkError = (e: unknown) => e instanceof TypeError || (e instanceof Error && /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed/i.test(e.message));

export class HostedChains {
  private readonly states = new Map<string, State>();
  private readonly chains: Record<Job, State[]> = { chat: [], docs: [], vision: [] };

  constructor(
    order: Record<Job, Entry[]> = readOrder(),
    private readonly now: () => number = Date.now,
    makeInstance: (name: string, model: string) => LlmProvider | null = (name, model) => (name === "ollama" ? new OllamaProvider(undefined, model) : makeProvider(name, model)),
  ) {
    const specs = providerSpecs();
    for (const job of Object.keys(ENV) as Job[]) {
      const allowed = (process.env[ENV[job]] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!allowed.length) continue;
      let entries = order[job].filter((e) => allowed.includes(e.provider) && (e.provider === "ollama" || cloudFallbackOn()));
      if (process.env.BEDROCK_ENABLED === "true" && process.env.BEDROCK_MODEL) entries = [{ provider: "bedrock", model: process.env.BEDROCK_MODEL }, ...entries.filter((e) => e.provider !== "bedrock")];
      const states: State[] = [];
      for (const e of entries) {
        const spec = specs[e.provider];
        if (!spec || (spec.disabled && e.provider !== "bedrock")) continue;
        if (job === "vision" && !(spec.images && spec.tier === "A")) continue; // tier B never receives images
        const key = `${e.provider}|${e.model}`;
        let state = this.states.get(key);
        if (!state) {
          const instance = makeInstance(e.provider, e.model);
          if (!instance) continue;
          state = { name: e.provider, model: e.model, tier: spec.tier, images: spec.images, instance, fewShot: Boolean(e.fewShot), failures: 0, openUntil: 0, probing: false, day: "", today: 0, minute: [], billingBlocked: false, lastStatus: "idle", lastAt: null };
          this.states.set(key, state);
        }
        states.push(state);
      }
      // Tier B never leads without written approval (LLM_TIER_B_LEAD_APPROVED): the first approved or tier A/local one goes first.
      const approved = (process.env.LLM_TIER_B_LEAD_APPROVED ?? "").split(",").map((s) => s.trim());
      const lead = states.findIndex((s) => s.tier !== "B" || approved.includes(s.name));
      if (lead > 0) states.unshift(...states.splice(lead, 1));
      this.chains[job] = states;
    }
  }

  chain(job: Job): Array<{ provider: string; model: string; tier: Tier; fewShot: boolean }> {
    return this.chains[job].map((s) => ({ provider: s.name, model: s.model, tier: s.tier, fewShot: s.fewShot }));
  }

  /** True when some provider in the job's chain wants few-shot examples (so the caller retrieves them once). */
  wantsFewShot(job: Job): boolean {
    return this.chains[job].some((s) => s.fewShot);
  }

  /** Daily and per-minute counters; false when a limit or the $0 spend cap is reached. */
  private withinLimits(s: State): boolean {
    const spec = providerSpecs()[s.name];
    const t = this.now();
    const day = new Date(t).toISOString().slice(0, 10);
    if (s.day !== day) {
      s.day = day;
      s.today = 0;
      s.billingBlocked = false;
    }
    if (s.billingBlocked) return false;
    s.minute = s.minute.filter((at) => t - at < 60000);
    if (spec?.perMinute && s.minute.length >= spec.perMinute) return false;
    if (spec?.perDay && s.today >= spec.perDay) return false;
    return true;
  }

  private available(s: State): boolean {
    if (s.openUntil > this.now()) return false;
    if (s.openUntil && !s.probing) s.probing = true; // half-open: this call is the probe
    return this.withinLimits(s);
  }

  private record(s: State, ok: boolean, status: string, ms: number, usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }): void {
    s.lastStatus = status;
    s.lastAt = new Date(this.now()).toISOString();
    if (ok) {
      s.failures = 0;
      s.openUntil = 0;
      s.probing = false;
    } else {
      s.failures += 1;
      if (s.probing || s.failures >= BREAKER_FAILURES) {
        s.openUntil = this.now() + BREAKER_OPEN_MS;
        s.probing = false;
      }
    }
    if (status === "billing" || (usage?.costUsd ?? 0) > 0) s.billingBlocked = true; // $0 cap: never pay
    if (process.env.LLM_LOG !== "off") console.info(JSON.stringify({ llm: s.name, model: s.model, ms: Math.round(ms), status, in: usage?.inputTokens ?? null, out: usage?.outputTokens ?? null }));
  }

  private async callOne(s: State, messages: ChatMessage[], options: CompletionOptions, deadline: number): Promise<{ text: string } | null> {
    const hosted = s.tier !== "local";
    const sent = hosted ? messages.map((m) => ({ ...m, content: maskForProvider(m.content) })) : messages;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const left = deadline - this.now();
      if (left < 500) return null;
      const timeoutMs = hosted ? Math.min(CALL_TIMEOUT_MS, left) : left;
      s.today += 1;
      s.minute.push(this.now());
      const t0 = this.now();
      try {
        const opts = { ...options, timeoutMs, images: s.images && s.tier === "A" ? options.images : undefined };
        const r = s.instance.call ? await s.instance.call(sent, opts) : { text: await s.instance.chat(sent, opts) };
        this.record(s, true, "ok", this.now() - t0, "usage" in r ? r.usage : undefined);
        return r;
      } catch (error) {
        const type = classifyProviderError(error);
        const status = error instanceof Error && /HTTP 402/.test(error.message) ? "billing" : type;
        this.record(s, false, status, this.now() - t0);
        if (attempt === 0 && isNetworkError(error) && type !== "timeout") continue; // one retry, network errors only
        return null;
      }
    }
    return null;
  }

  /** Text from the first provider in the job's chain that answers within the budget; null = rules only. */
  async complete(job: Job, messages: ChatMessage[], options: CompletionOptions = {}): Promise<string | null> {
    const deadline = this.now() + CHAIN_BUDGET_MS;
    for (const s of this.chains[job]) {
      if (!this.available(s)) continue;
      const r = await this.callOne(s, messages, options, deadline);
      if (r) return r.text;
      if (deadline - this.now() < 500) break;
    }
    return null;
  }

  /** Schema-validated JSON; a provider whose reply doesn't parse or validate counts as a failure and the next one is asked. */
  async json<T>(job: Job, messages: ChatMessage[], schema: ZodType<T>, options: CompletionOptions = {}): Promise<T | null> {
    const deadline = this.now() + CHAIN_BUDGET_MS;
    for (const s of this.chains[job]) {
      if (!this.available(s)) continue;
      const sent = s.fewShot && options.fewShotMessages ? options.fewShotMessages : messages;
      const r = await this.callOne(s, sent, { temperature: 0.1, ...options, json: options.json ?? true }, deadline);
      if (r) {
        try {
          const parsed = schema.safeParse(extractJson(r.text));
          if (parsed.success) return parsed.data;
          this.record(s, false, "schema_failed", 0);
        } catch {
          this.record(s, false, "invalid_json", 0);
        }
      }
      if (deadline - this.now() < 500) break;
    }
    return null;
  }

  /** For /health/ai: no keys, no prompts. */
  status(): Array<{ provider: string; model: string; tier: Tier; configured: boolean; state: "up" | "down" | "rate_limited" | "billing_blocked"; today: number; lastStatus: string; lastAt: string | null }> {
    return [...this.states.values()].map((s) => ({
      provider: s.name,
      model: s.model,
      tier: s.tier,
      configured: s.name === "ollama" || Boolean(providerKey(s.name)) || s.name === "bedrock",
      state: s.billingBlocked ? "billing_blocked" : s.openUntil > this.now() ? "down" : this.withinLimits(s) ? "up" : "rate_limited",
      today: s.today,
      lastStatus: s.lastStatus,
      lastAt: s.lastAt,
    }));
  }
}

let shared: HostedChains | null = null;
export function getChains(): HostedChains {
  shared ??= new HostedChains();
  return shared;
}
export function setChains(c: HostedChains | null): void {
  shared = c;
}
