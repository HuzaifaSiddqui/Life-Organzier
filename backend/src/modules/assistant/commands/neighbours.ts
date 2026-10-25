import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { embedTexts, HASH_EMBED_MODEL, hashEmbedding } from "../../../ai/embeddings.js";

/**
 * Nearest examples from tests/eval/utterance-bank.json for a message (meaning-based routing, see router.ts and
 * docs/AI_ASSISTANT_ARCHITECTURE.md). The bank is embedded once per embedding model and cached in backend/.cache
 * (keyed by model id and the bank's content). With AI off, or the embedding model down, the hashed bag-of-words
 * vectors from ai/embeddings.ts are used instead: they only see shared words, not meaning.
 */
export type BankRow = { id: string; text: string; lang: string; command: string; args?: Record<string, unknown>; source?: string };
export type Neighbour = { row: BankRow; score: number };
export type BankIndex = { model: string; rows: BankRow[]; vectors: number[][] };

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const BANK_PATH = join(BACKEND, "tests/eval/utterance-bank.json");
const CACHE_DIR = join(BACKEND, ".cache");
/** The router works in English and Roman Urdu only (Urdu script is planned after the deadline). */
export const ROUTER_LANGS = new Set(["en", "ru"]);

let bankCache: BankRow[] | null = null;
export function loadBank(): BankRow[] {
  bankCache ??= (JSON.parse(readFileSync(BANK_PATH, "utf8")) as { rows: BankRow[] }).rows.filter((r) => ROUTER_LANGS.has(r.lang));
  return bankCache;
}

const indexes = new Map<string, BankIndex>();

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function hashIndex(rows = loadBank()): BankIndex {
  return { model: HASH_EMBED_MODEL, rows, vectors: rows.map((r) => hashEmbedding(r.text)) };
}

/** The bank embedded with the embedding model (cached on disk), or the hashed index when that model is off or down. */
export async function bankIndex(useModel: boolean, rows = loadBank()): Promise<BankIndex> {
  if (!useModel) return hashIndex(rows);
  const digest = createHash("sha256").update(JSON.stringify(rows.map((r) => r.text))).digest("hex").slice(0, 16);
  const cached = [...indexes.values()].find((i) => i.rows === rows && i.model !== HASH_EMBED_MODEL);
  if (cached) return cached;
  const model = process.env.EMBEDDING_MODEL ?? "nomic-embed-text";
  const file = join(CACHE_DIR, `utterance-bank.${model.replace(/[^a-z0-9.-]/gi, "_")}.${digest}.json`);
  if (existsSync(file)) {
    const index = { model, rows, vectors: JSON.parse(readFileSync(file, "utf8")) as number[][] };
    indexes.set(file, index);
    return index;
  }
  const result = await embedTexts(rows.map((r) => r.text), "document");
  if (result.model === HASH_EMBED_MODEL) return hashIndex(rows);
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(result.vectors));
  const index = { model: result.model, rows, vectors: result.vectors };
  indexes.set(file, index);
  return index;
}

/** The k nearest bank rows (leave-one-out: `exclude` drops that row id). */
export async function nearest(text: string, index: BankIndex, opts: { k?: number; exclude?: string } = {}): Promise<Neighbour[]> {
  let query: number[];
  if (index.model === HASH_EMBED_MODEL) query = hashEmbedding(text);
  else {
    const r = await embedTexts([text], "query");
    // The model went down since the bank was embedded: compare like with like.
    if (r.model !== index.model) return nearest(text, hashIndex(index.rows), opts);
    query = r.vectors[0];
  }
  return index.rows
    .map((row, i) => ({ row, score: cosine(query, index.vectors[i]) }))
    .filter((n) => n.row.id !== opts.exclude)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.k ?? 5);
}

/** The neighbours' answer: the command with the most similarity weight, its share of the weight, and the best score. */
export function vote(list: Neighbour[]): { command: string | null; agreement: number; top: number; lang: string | null } {
  const weight = new Map<string, number>();
  const langs = new Map<string, number>();
  let total = 0;
  for (const n of list) {
    const w = Math.max(0, n.score);
    weight.set(n.row.command, (weight.get(n.row.command) ?? 0) + w);
    langs.set(n.row.lang, (langs.get(n.row.lang) ?? 0) + w);
    total += w;
  }
  const best = [...weight.entries()].sort((a, b) => b[1] - a[1])[0];
  const lang = [...langs.entries()].sort((a, b) => b[1] - a[1])[0];
  return { command: best?.[0] ?? null, agreement: best && total ? best[1] / total : 0, top: list[0]?.score ?? 0, lang: lang?.[0] ?? null };
}
