import type { ZodType } from "zod";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type CompletionOptions = {
  /** A JSON schema object constrains output (Ollama structured outputs); `true` requests free-form JSON. */
  json?: Record<string, unknown> | boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /**
   * Background work (memory extraction, summaries) yields to live user requests: a local model
   * on CPU handles one request at a time, so background calls run one by one and only when no
   * foreground request is in flight.
   */
  background?: boolean;
};

export interface LlmProvider {
  readonly name: string;
  chat(messages: ChatMessage[], options: CompletionOptions): Promise<string>;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class OllamaProvider implements LlmProvider {
  readonly name = "ollama";

  constructor(
    private readonly baseUrl = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
    private readonly model = process.env.OLLAMA_MODEL ?? "qwen2.5:7b",
    private readonly timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS ?? 60000),
  ) {}

  async chat(messages: ChatMessage[], options: CompletionOptions): Promise<string> {
    const response = await fetchWithTimeout(
      `${this.baseUrl.replace(/\/$/, "")}/api/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          ...(options.json ? { format: options.json === true ? "json" : options.json } : {}),
          keep_alive: "30m",
          options: {
            temperature: options.temperature ?? 0.2,
            num_predict: options.maxTokens ?? 400,
            num_ctx: 4096,
          },
        }),
      },
      Math.min(options.timeoutMs ?? this.timeoutMs, this.timeoutMs),
    );
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
    const body = (await response.json()) as { message?: { content?: string } };
    const text = body.message?.content ?? "";
    if (!text.trim()) throw new Error("Ollama returned an empty response");
    return text;
  }
}

export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";

  constructor(
    private readonly apiKey = process.env.GEMINI_API_KEY,
    private readonly model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
    private readonly timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS ?? 15000),
  ) {}

  async chat(messages: ChatMessage[], options: CompletionOptions): Promise<string> {
    if (!this.apiKey) throw new Error("GEMINI_API_KEY is not set");
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    const schemaHint =
      options.json && options.json !== true ? `\n\nReturn JSON matching this JSON schema:\n${JSON.stringify(options.json)}` : "";
    const response = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(system || schemaHint ? { systemInstruction: { parts: [{ text: `${system}${schemaHint}` }] } } : {}),
          contents,
          generationConfig: {
            temperature: options.temperature ?? 0.2,
            maxOutputTokens: options.maxTokens ?? 400,
            ...(options.json ? { responseMimeType: "application/json" } : {}),
          },
        }),
      },
      options.timeoutMs ?? this.timeoutMs,
    );
    if (!response.ok) throw new Error(`Gemini API error (HTTP ${response.status})`);
    const body = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text.trim()) throw new Error("Gemini returned an empty response");
    return text;
  }
}

export function extractJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.search(/[[{]/);
  if (start < 0) throw new Error("No JSON in model output");
  const open = cleaned[start];
  const close = open === "{" ? "}" : "]";
  const end = cleaned.lastIndexOf(close);
  if (end <= start) throw new Error("Unterminated JSON in model output");
  return JSON.parse(cleaned.slice(start, end + 1));
}

type ProviderState = { provider: LlmProvider; downUntil: number };

/**
 * Provider chain with a short circuit-breaker: when a provider fails it is skipped for 30s so a
 * stopped Ollama never adds latency to every request — the deterministic pipeline keeps working.
 */
export class AiService {
  private readonly chain: ProviderState[];

  constructor(providers?: LlmProvider[]) {
    if (providers) {
      this.chain = providers.map((provider) => ({ provider, downUntil: 0 }));
      return;
    }
    if (process.env.AI_ENABLED?.toLowerCase() === "false") {
      this.chain = [];
      return;
    }
    const primary = (process.env.AI_PROVIDER ?? "ollama").toLowerCase();
    const list: LlmProvider[] = [];
    if (primary === "gemini") {
      list.push(new GeminiProvider(), new OllamaProvider());
    } else if (primary === "ollama") {
      list.push(new OllamaProvider());
      if (process.env.GEMINI_API_KEY && process.env.GEMINI_FALLBACK === "true") list.push(new GeminiProvider());
    }
    this.chain = list.map((provider) => ({ provider, downUntil: 0 }));
  }

  get enabled(): boolean {
    return this.chain.length > 0;
  }

  get available(): boolean {
    return this.chain.some((s) => s.downUntil <= Date.now());
  }

  private foregroundInFlight = 0;
  private lastForegroundAt = 0;
  private backgroundQueue: Promise<unknown> = Promise.resolve();

  async complete(messages: ChatMessage[], options: CompletionOptions = {}): Promise<string | null> {
    if (!options.background) {
      this.foregroundInFlight += 1;
      this.lastForegroundAt = Date.now();
      try {
        return await this.run(messages, options);
      } finally {
        this.foregroundInFlight -= 1;
        this.lastForegroundAt = Date.now();
      }
    }
    const job = this.backgroundQueue.then(async () => {
      const deadline = Date.now() + 120000;
      while ((this.foregroundInFlight > 0 || Date.now() - this.lastForegroundAt < 3000) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
      }
      return this.run(messages, options);
    });
    this.backgroundQueue = job.catch(() => undefined);
    return job;
  }

  private async run(messages: ChatMessage[], options: CompletionOptions): Promise<string | null> {
    for (const state of this.chain) {
      if (state.downUntil > Date.now()) continue;
      try {
        return await state.provider.chat(messages, options);
      } catch (error) {
        state.downUntil = Date.now() + 30000;
        console.warn(`AI provider ${state.provider.name} unavailable:`, error instanceof Error ? error.message : error);
      }
    }
    return null;
  }

  /** Structured completion validated with zod. Returns null instead of throwing on any failure. */
  async json<T>(messages: ChatMessage[], schema: ZodType<T>, options: CompletionOptions = {}): Promise<T | null> {
    const text = await this.complete(messages, { temperature: 0.1, ...options, json: options.json ?? true });
    if (!text) return null;
    try {
      const parsed = schema.safeParse(extractJson(text));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}

let shared: AiService | null = null;

export function getAi(): AiService {
  shared ??= new AiService();
  return shared;
}

/** Test hook: replace the shared service with a mock. */
export function setAi(service: AiService | null): void {
  shared = service;
}

export type ModelStatus = { checked: boolean; chat: boolean | null; embeddings: boolean | null; missing: string[] };
const modelStatus: ModelStatus = { checked: false, chat: null, embeddings: null, missing: [] };

export function getModelStatus(): ModelStatus {
  return modelStatus;
}

/**
 * Startup check: a missing Ollama model otherwise fails silently (rules-only replies, hashed
 * embeddings). Also loads the chat model so the first user request doesn't pay the load time and
 * trip the intent timeout.
 */
export async function checkAndWarmModels(): Promise<void> {
  const ai = getAi();
  // Ollama is the primary provider, or Gemini's fallback.
  if (!ai.enabled || !["ollama", "gemini"].includes((process.env.AI_PROVIDER ?? "ollama").toLowerCase())) return;
  const base = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  const chatModel = process.env.OLLAMA_MODEL ?? "qwen2.5:7b";
  const embedModel = process.env.EMBEDDING_MODEL ?? "nomic-embed-text";
  try {
    const res = await fetchWithTimeout(`${base}/api/tags`, {}, 5000);
    const names = ((await res.json()) as { models?: Array<{ name: string }> }).models?.map((m) => m.name) ?? [];
    const has = (m: string) => names.some((n) => n === m || n === `${m}:latest`);
    modelStatus.chat = has(chatModel);
    modelStatus.embeddings = process.env.EMBEDDINGS_ENABLED?.toLowerCase() === "false" ? null : has(embedModel);
    modelStatus.missing = [modelStatus.chat ? null : chatModel, modelStatus.embeddings === false ? embedModel : null].filter((m): m is string => Boolean(m));
    modelStatus.checked = true;
    for (const m of modelStatus.missing) console.warn(`⚠️  Ollama model "${m}" is not installed — run: ollama pull ${m}`);
    if (modelStatus.chat) {
      await fetchWithTimeout(`${base}/api/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: chatModel, keep_alive: "30m" }) }, 120000);
      console.info(`AI model ${chatModel} loaded`);
    }
  } catch (error) {
    modelStatus.checked = true;
    console.warn("⚠️  Ollama is not reachable — the assistant will answer with rules only:", error instanceof Error ? error.message : error);
  }
}
