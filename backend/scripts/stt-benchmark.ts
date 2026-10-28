/**
 * Speech-to-text benchmark for WhatsApp voice notes (docs/whatsapp-agent.md "Voice notes").
 *
 *   cd backend
 *   STT_PROVIDER=whisper-local npm run stt:bench -- <folder>
 *
 * <folder> holds voice notes (e.g. note1.ogg, exported from WhatsApp) each with a reference transcript next to it
 * (note1.txt: what was actually said, English or Roman Urdu as you would type it). Prints word error rate and
 * latency per file and overall, per language (a file whose name contains "ru" or "urdu" counts as Roman Urdu).
 * Audio stays wherever the provider runs: whisper-local keeps it on this machine. Nothing is written to disk.
 */
import "dotenv/config";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { getStt } from "../src/ai/stt.js";
import { editDistance } from "../src/lib/text.js";

const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);

/** Word error rate: word-level edit distance over the reference length. */
export function wer(reference: string, hypothesis: string): number {
  const ref = words(reference);
  const hyp = words(hypothesis);
  if (!ref.length) return hyp.length ? 1 : 0;
  // editDistance works on strings; map each distinct word to one character.
  const ids = new Map<string, string>();
  const enc = (ws: string[]) => ws.map((w) => ids.get(w) ?? (ids.set(w, String.fromCodePoint(0x4e00 + ids.size)), ids.get(w) as string)).join("");
  return editDistance(enc(ref), enc(hyp)) / ref.length;
}

const MIME: Record<string, string> = { ".ogg": "audio/ogg", ".opus": "audio/ogg", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav" };

async function main(): Promise<void> {
  const dir = process.argv[2];
  const stt = getStt();
  if (!dir || !existsSync(dir)) throw new Error("Usage: npm run stt:bench -- <folder with voice notes and .txt references>");
  if (!stt) throw new Error("Set STT_PROVIDER (e.g. whisper-local) to the provider to test.");
  const files = readdirSync(dir).filter((f) => MIME[extname(f).toLowerCase()]);
  const rows: Array<{ file: string; lang: string; wer: number; ms: number }> = [];
  for (const f of files) {
    const ref = join(dir, `${basename(f, extname(f))}.txt`);
    if (!existsSync(ref)) continue;
    const t = await stt.transcribe(readFileSync(join(dir, f)), MIME[extname(f).toLowerCase()], { languages: ["en", "ur"], timeoutMs: 120000 });
    const lang = /(^|[-_.])(ru|urdu)([-_.]|$)/i.test(f) ? "Roman Urdu" : "English";
    rows.push({ file: f, lang, wer: wer(readFileSync(ref, "utf8"), t.text), ms: t.ms });
    console.log(`${f.padEnd(28)} ${lang.padEnd(11)} WER ${(rows.at(-1)!.wer * 100).toFixed(0).padStart(3)}%  ${t.ms} ms`);
  }
  for (const lang of ["English", "Roman Urdu"]) {
    const r = rows.filter((x) => x.lang === lang);
    if (!r.length) continue;
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    console.log(`\n${lang}: ${r.length} notes, mean WER ${(mean(r.map((x) => x.wer)) * 100).toFixed(1)}%, mean latency ${Math.round(mean(r.map((x) => x.ms)))} ms (provider ${stt.name})`);
  }
}

if (process.argv[1] && /stt-benchmark/.test(process.argv[1])) void main().catch((e) => (console.error(e instanceof Error ? e.message : e), process.exit(1)));
