/**
 * Speech-to-text behind a provider interface, like the LLM chain in llm.ts. Audio can't be masked before it
 * leaves the server, so only providers the project owner approved may be configured (STT_PROVIDER); the default
 * is none, and WhatsApp voice notes then get "please type it". Candidates and their data terms are listed in
 * docs/whatsapp-agent.md ("Voice notes"). Nothing here adds an npm dependency.
 */

export type Transcript = {
  text: string;
  /** 0..1 when the provider reports one; null when it doesn't. */
  confidence: number | null;
  language: string | null;
  ms: number;
};

export interface SttProvider {
  readonly name: string;
  /** Where the audio goes, for the docs and the status endpoint ("this server", "OpenAI", …). */
  readonly dataLocation: string;
  transcribe(audio: Buffer, mimeType: string, opts: { languages: string[]; timeoutMs: number }): Promise<Transcript>;
}

/** Below this the user is asked to type it instead. Providers without a confidence are judged on the text alone. */
export const MIN_STT_CONFIDENCE = 0.6;

/** Whisper's typical non-speech outputs. */
const NOISE = /^\s*[[(]?\s*(blank_audio|music|silence|no speech|inaudible|noise)\s*[\])]?\s*\.?\s*$/i;

/** A transcript worth acting on: some words, not a noise marker, confident enough when a confidence is given. */
export function usableTranscript(t: Transcript | null): t is Transcript {
  if (!t) return false;
  const text = t.text.trim();
  if (text.length < 2 || NOISE.test(text)) return false;
  return t.confidence === null || t.confidence >= MIN_STT_CONFIDENCE;
}

/**
 * Local whisper.cpp server (https://github.com/ggml-org/whisper.cpp, `whisper-server`): audio never leaves the
 * machine. Needs whisper.cpp built with its server, a model file (e.g. ggml-small.bin, multilingual) and ffmpeg
 * for WhatsApp's Ogg/Opus (`whisper-server -m models/ggml-small.bin --convert --port 8178`). Not installed by npm.
 */
export class WhisperCppProvider implements SttProvider {
  readonly name = "whisper-local";
  readonly dataLocation = "this server (whisper.cpp)";

  constructor(private readonly baseUrl = (process.env.WHISPER_URL || "http://127.0.0.1:8178").replace(/\/$/, "")) {}

  async transcribe(audio: Buffer, mimeType: string, opts: { languages: string[]; timeoutMs: number }): Promise<Transcript> {
    const started = Date.now();
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), mimeType.includes("ogg") ? "voice.ogg" : "voice.audio");
    form.append("response_format", "verbose_json");
    form.append("temperature", "0");
    // Roman Urdu is spoken Urdu; whisper writes it in Urdu script unless told the language is English. "auto" lets
    // it choose, which the benchmark compares against forcing "en" (docs/whatsapp-agent.md).
    form.append("language", opts.languages.length === 1 ? opts.languages[0] : "auto");
    const res = await fetch(`${this.baseUrl}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(opts.timeoutMs) });
    if (!res.ok) throw new Error(`whisper.cpp HTTP ${res.status}`);
    const json = (await res.json()) as { text?: string; language?: string; segments?: Array<{ avg_logprob?: number; no_speech_prob?: number }> };
    const segs = json.segments ?? [];
    // whisper.cpp's verbose_json may carry per-segment log probabilities; map their mean to 0..1 when present.
    const logprobs = segs.map((s) => s.avg_logprob).filter((x): x is number => typeof x === "number");
    const confidence = logprobs.length ? Math.max(0, Math.min(1, Math.exp(logprobs.reduce((a, b) => a + b, 0) / logprobs.length))) : null;
    return { text: (json.text ?? "").trim(), confidence, language: json.language ?? null, ms: Date.now() - started };
  }
}

let provider: SttProvider | null | undefined;

/** The configured provider, or null (STT_PROVIDER unset or "none"). */
export function getStt(): SttProvider | null {
  if (provider !== undefined) return provider;
  provider = process.env.STT_PROVIDER === "whisper-local" ? new WhisperCppProvider() : null;
  return provider;
}

/** Test hook (undefined = read STT_PROVIDER again). */
export function setStt(p: SttProvider | null | undefined): void {
  provider = p;
}
