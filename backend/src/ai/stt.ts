import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Speech-to-text behind a provider interface, like the LLM chain in llm.ts. Audio can't be masked, so it is
 * transcribed locally and never leaves the machine:
 *  - faster-whisper (default, STT_PROVIDER=faster-whisper): Python, scripts/transcribe.py, as in the WhatsApp agent
 *    test project (python -m pip install -r scripts/requirements-voice.txt);
 *  - whisper.cpp server (STT_PROVIDER=whisper-local).
 * STT_PROVIDER=none turns transcription off. When the transcriber isn't installed or running, WhatsApp voice notes
 * get "please type it". No npm dependency.
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
  /** Whether it can take audio right now (e.g. the local server is running). Absent = always. */
  ready?(): Promise<boolean>;
}

const readyCache = new Map<string, { at: number; ok: boolean }>();

/** `provider.ready()`, remembered (10 min when ready, 1 min when not) so voice notes don't re-check each time. */
export async function sttReady(provider: SttProvider | null): Promise<boolean> {
  if (!provider) return false;
  if (!provider.ready) return true;
  const hit = readyCache.get(provider.name);
  if (hit && Date.now() - hit.at < (hit.ok ? 10 * 60000 : 60000)) return hit.ok;
  const ok = await provider.ready().catch(() => false);
  readyCache.set(provider.name, { at: Date.now(), ok });
  return ok;
}

/**
 * Below this the user is asked to type it instead (exp of the mean segment log-probability). A clear real voice
 * note scored 0.66 with faster-whisper "small", so the bar sits well under that. Providers without a confidence are
 * judged on the text alone.
 */
export const MIN_STT_CONFIDENCE = 0.45;

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

  /** Any answer from the server counts: whisper-server serves a page at "/". */
  async ready(): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    return Boolean(res);
  }

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

/** Runs a command; resolves with stdout, rejects on a non-zero exit, a spawn error or the timeout. */
function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (err += c));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("transcription timed out"));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().split("\n").pop() || `exit ${code}`));
    });
  });
}

/**
 * faster-whisper through scripts/transcribe.py (the same approach as the WhatsApp agent test project). One voice
 * note at a time (CPU-heavy). WHISPER_PYTHON picks the interpreter, WHISPER_MODEL the model ("small" by default;
 * "base" or "tiny" on slow machines). The model is downloaded the first time it is used.
 */
export class FasterWhisperProvider implements SttProvider {
  readonly name = "faster-whisper";
  readonly dataLocation = "this server (faster-whisper)";
  private queue: Promise<unknown> = Promise.resolve();
  private readonly script = fileURLToPath(new URL("../../scripts/transcribe.py", import.meta.url));

  constructor(
    private readonly python = process.env.WHISPER_PYTHON || (process.platform === "win32" ? "python" : "python3"),
    private readonly model = process.env.WHISPER_MODEL || "small",
  ) {}

  async ready(): Promise<boolean> {
    return run(this.python, [this.script, "--file", "-", "--check"], 20000).then(
      () => true,
      () => false,
    );
  }

  transcribe(audio: Buffer, mimeType: string, opts: { languages: string[]; timeoutMs: number }): Promise<Transcript> {
    const job = this.queue.then(() => this.once(audio, mimeType, opts.timeoutMs));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async once(audio: Buffer, mimeType: string, timeoutMs: number): Promise<Transcript> {
    const started = Date.now();
    const dir = await mkdtemp(join(tmpdir(), "lo-voice-"));
    const file = join(dir, mimeType.includes("ogg") ? "voice.ogg" : mimeType.includes("mp4") ? "voice.m4a" : mimeType.includes("mpeg") ? "voice.mp3" : "voice.audio");
    try {
      await writeFile(file, audio);
      const out = JSON.parse(await run(this.python, [this.script, "--file", file, "--model", this.model], timeoutMs)) as { text?: string; language?: string; confidence?: number | null };
      return { text: (out.text ?? "").trim(), confidence: typeof out.confidence === "number" ? out.confidence : null, language: out.language ?? null, ms: Date.now() - started };
    } finally {
      await rm(dir, { recursive: true, force: true }); // the audio is not kept
    }
  }
}

let provider: SttProvider | null | undefined;

/** The configured local provider (faster-whisper unless STT_PROVIDER says whisper-local or none), or null. */
export function getStt(): SttProvider | null {
  if (provider !== undefined) return provider;
  const name = process.env.STT_PROVIDER || "faster-whisper";
  provider = name === "none" ? null : name === "whisper-local" ? new WhisperCppProvider() : new FasterWhisperProvider();
  return provider;
}

/** Test hook (undefined = read STT_PROVIDER again). */
export function setStt(p: SttProvider | null | undefined): void {
  provider = p;
}
