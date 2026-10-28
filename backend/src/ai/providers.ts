import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderHttpError, type ChatMessage, type CompletionOptions, type LlmProvider } from "./llm.js";

/**
 * Hosted model providers behind one interface (LlmProvider.call): system/messages, optional JSON (schema or free),
 * optional images, a timeout; returns text plus token counts. Plain fetch, no SDKs. Static facts (endpoint, key
 * variable names, privacy tier, limits) live in config/providers.json; the order of a job's chain in
 * config/provider-order.json ("chains": decided; "ranking": written by scripts/bench-providers.ts). Nothing here logs prompts or keys.
 */

export type Tier = "local" | "A" | "B";
export type ProviderSpec = {
  kind: "ollama" | "openai" | "gemini" | "bedrock";
  baseUrl?: string;
  keyEnv: string[];
  tier: Tier;
  images: boolean;
  paid?: boolean;
  freeOnly?: boolean;
  perMinute?: number;
  perDay?: number;
  disabled?: boolean;
  extraBody?: Record<string, unknown>;
  /** Reasoning models spend output tokens thinking before they answer: never ask for fewer than this. */
  minOutputTokens?: number;
  evidence: string;
};
export type Usage = { inputTokens?: number; outputTokens?: number; costUsd?: number };
export type CallResult = { text: string; usage?: Usage };

const CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../config");
let specs: Record<string, ProviderSpec> | null = null;
export function providerSpecs(): Record<string, ProviderSpec> {
  specs ??= (JSON.parse(readFileSync(join(CONFIG_DIR, "providers.json"), "utf8")) as { providers: Record<string, ProviderSpec> }).providers;
  return specs;
}

/** The first configured key of a provider (Deploy has two, one per account). Values are never logged. */
export function providerKey(name: string, which = 0): string | undefined {
  const names = providerSpecs()[name]?.keyEnv ?? [];
  return names.map((n) => process.env[n]).filter((v): v is string => Boolean(v))[which];
}

async function post(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
}

/** A JSON-schema object becomes an instruction (not every OpenAI-compatible host takes json_schema). */
function schemaHint(options: CompletionOptions): string {
  return options.json && options.json !== true ? `\n\nReturn only JSON matching this JSON schema:\n${JSON.stringify(options.json)}` : options.json ? "\n\nReturn only JSON." : "";
}

/** OpenAI-compatible chat completions: Groq, Cerebras, Together, OpenRouter, Deploy. Non-streaming. */
export class OpenAiCompatibleProvider implements LlmProvider {
  /** The provider's own request quota from its response headers (counts only), for quota headroom. */
  rateLimit: { remainingRequests: number; limitRequests: number } | null = null;
  constructor(
    readonly name: string,
    readonly model: string,
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    private readonly extraBody: Record<string, unknown> = {},
    private readonly minOutputTokens = 0,
  ) {}

  async chat(messages: ChatMessage[], options: CompletionOptions): Promise<string> {
    return (await this.call(messages, options)).text;
  }

  async call(messages: ChatMessage[], options: CompletionOptions): Promise<CallResult> {
    if (!this.apiKey) throw new Error(`${this.name}: no API key configured`);
    const hint = schemaHint(options);
    // The JSON instruction goes into the system message (one is added when there is none).
    const withSystem: ChatMessage[] = messages.some((m) => m.role === "system") ? messages : hint ? [{ role: "system", content: "" }, ...messages] : messages;
    const lastUser = withSystem.map((m) => m.role).lastIndexOf("user");
    const body = {
      model: this.model,
      messages: withSystem.map((m, i) => {
        const content = m.role === "system" ? `${m.content}${hint}`.trim() : m.content;
        if (i !== lastUser || !options.images?.length) return { role: m.role, content };
        return { role: m.role, content: [{ type: "text", text: content }, ...options.images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data}` } }))] };
      }),
      temperature: options.temperature ?? 0.2,
      max_tokens: Math.max(options.maxTokens ?? 400, this.minOutputTokens),
      stream: false,
      ...(options.json ? { response_format: { type: "json_object" } } : {}),
      ...this.extraBody,
    };
    const response = await post(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, body, { Authorization: `Bearer ${this.apiKey}` }, options.timeoutMs ?? 8000);
    const remaining = response.headers.get("x-ratelimit-remaining-requests");
    if (remaining !== null) this.rateLimit = { remainingRequests: Number(remaining), limitRequests: Number(response.headers.get("x-ratelimit-limit-requests") ?? NaN) };
    if (!response.ok) {
      // Error code only (e.g. json_validate_failed): never the message, which can echo the prompt.
      const code = await response.json().then((b: { error?: { code?: unknown } }) => b.error?.code, () => undefined);
      throw new ProviderHttpError(response.status, `${this.name} returned HTTP ${response.status}${typeof code === "string" ? ` (${code.slice(0, 40)})` : ""}`);
    }
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const text = json.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) throw new Error(`${this.name} returned an empty response`);
    return { text, usage: { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens, costUsd: json.usage?.cost } };
  }
}

/** Gemini generateContent with an explicit model, images (inline_data) and token counts. */
export class GeminiModelProvider implements LlmProvider {
  readonly name = "gemini";
  /** Models that answered HTTP 400 to a thinking budget (asked again without it, remembered). */
  static readonly noThinkingConfig = new Set<string>();
  constructor(
    readonly model: string,
    private readonly apiKey = process.env.GEMINI_API_KEY,
  ) {}

  async chat(messages: ChatMessage[], options: CompletionOptions): Promise<string> {
    return (await this.call(messages, options)).text;
  }

  async call(messages: ChatMessage[], options: CompletionOptions): Promise<CallResult> {
    if (!this.apiKey) throw new Error("gemini: no API key configured");
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const rest = messages.filter((m) => m.role !== "system");
    const lastUser = rest.map((m) => m.role).lastIndexOf("user");
    const contents = rest.map((m, i) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }, ...(i === lastUser ? (options.images ?? []).map((img) => ({ inline_data: { mime_type: img.mimeType, data: img.data } })) : [])],
    }));
    const hint = schemaHint(options);
    const request = (thinking: boolean) =>
      post(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
        {
          ...(system || hint ? { systemInstruction: { parts: [{ text: `${system}${hint}` }] } } : {}),
          contents,
          generationConfig: {
            temperature: options.temperature ?? 0.2,
            maxOutputTokens: options.maxTokens ?? 400,
            ...(options.json ? { responseMimeType: "application/json" } : {}),
            // Flash models think by default and can spend the output budget on it; some (3.5-flash-lite) reject a budget of 0.
            ...(thinking ? { thinkingConfig: { thinkingBudget: Number(process.env.GEMINI_THINKING_BUDGET ?? 0) } } : {}),
          },
        },
        { "x-goog-api-key": this.apiKey as string },
        options.timeoutMs ?? 8000,
      );
    let response = await request(!GeminiModelProvider.noThinkingConfig.has(this.model));
    if (response.status === 400 && !GeminiModelProvider.noThinkingConfig.has(this.model)) {
      GeminiModelProvider.noThinkingConfig.add(this.model);
      response = await request(false);
    }
    if (!response.ok) throw new ProviderHttpError(response.status, `gemini returned HTTP ${response.status}`);
    const json = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text.trim()) throw new Error("gemini returned an empty response");
    return { text, usage: { inputTokens: json.usageMetadata?.promptTokenCount, outputTokens: json.usageMetadata?.candidatesTokenCount } };
  }
}

/* ------------------------------------------------------------------ AWS Bedrock (Converse API, SigV4) */

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const hmac = (key: Buffer | string, s: string) => createHmac("sha256", key).update(s).digest();

/** AWS Signature Version 4 headers for one POST (exported for the mocked test). */
export function sigV4Headers(opts: { method: string; host: string; path: string; body: string; region: string; service: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string; now?: Date }): Record<string, string> {
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(opts.body);
  const headers: Record<string, string> = { host: opts.host, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash, "content-type": "application/json" };
  if (opts.sessionToken) headers["x-amz-security-token"] = opts.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalPath = opts.path.split("/").map((seg) => encodeURIComponent(decodeURIComponent(seg))).join("/");
  const canonical = [opts.method, canonicalPath, "", ...names.map((n) => `${n}:${headers[n].trim()}`), "", names.join(";"), payloadHash].join("\n");
  const scope = `${day}/${opts.region}/${opts.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${opts.secretAccessKey}`, day), opts.region), opts.service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

/** Bedrock Converse. Disabled unless BEDROCK_ENABLED=true; only mocked tests until there is AWS access. */
export class BedrockProvider implements LlmProvider {
  readonly name = "bedrock";
  constructor(
    readonly model = process.env.BEDROCK_MODEL ?? "",
    private readonly region = process.env.AWS_REGION ?? "us-east-1",
  ) {}

  async chat(messages: ChatMessage[], options: CompletionOptions): Promise<string> {
    return (await this.call(messages, options)).text;
  }

  async call(messages: ChatMessage[], options: CompletionOptions): Promise<CallResult> {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (process.env.BEDROCK_ENABLED !== "true" || !accessKeyId || !secretAccessKey || !this.model) throw new Error("bedrock: disabled or not configured");
    const host = `bedrock-runtime.${this.region}.amazonaws.com`;
    const path = `/model/${encodeURIComponent(this.model)}/converse`;
    const system = messages.filter((m) => m.role === "system").map((m) => ({ text: `${m.content}${schemaHint(options)}` }));
    const body = JSON.stringify({
      ...(system.length ? { system } : {}),
      messages: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: [{ text: m.content }] })),
      inferenceConfig: { maxTokens: options.maxTokens ?? 400, temperature: options.temperature ?? 0.2 },
    });
    const headers = sigV4Headers({ method: "POST", host, path, body, region: this.region, service: "bedrock", accessKeyId, secretAccessKey, sessionToken: process.env.AWS_SESSION_TOKEN });
    const response = await fetch(`https://${host}${path}`, { method: "POST", headers, body, signal: AbortSignal.timeout(options.timeoutMs ?? 8000) });
    if (!response.ok) throw new ProviderHttpError(response.status, `bedrock returned HTTP ${response.status}`);
    const json = (await response.json()) as { output?: { message?: { content?: Array<{ text?: string }> } }; usage?: { inputTokens?: number; outputTokens?: number } };
    const text = json.output?.message?.content?.map((c) => c.text ?? "").join("") ?? "";
    if (!text.trim()) throw new Error("bedrock returned an empty response");
    return { text, usage: { inputTokens: json.usage?.inputTokens, outputTokens: json.usage?.outputTokens } };
  }
}

/** A provider instance for one chain entry ({provider, model}); null when it can't run (no key, disabled). */
export function makeProvider(name: string, model: string, keyIndex = 0): LlmProvider | null {
  const spec = providerSpecs()[name];
  if (!spec) return null;
  if (spec.kind === "gemini") return providerKey(name) ? new GeminiModelProvider(model, providerKey(name)) : null;
  if (spec.kind === "bedrock") return new BedrockProvider(model);
  if (spec.kind === "openai") {
    if (spec.freeOnly && !model.endsWith(":free")) return null; // $0 cap: OpenRouter free models only
    const key = providerKey(name, keyIndex);
    return key && spec.baseUrl ? new OpenAiCompatibleProvider(name, model, spec.baseUrl, key, spec.extraBody, spec.minOutputTokens) : null;
  }
  return null;
}
