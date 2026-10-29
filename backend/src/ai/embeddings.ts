/**
 * Text embeddings for semantic memory. Primary: Ollama `nomic-embed-text` (768-d, runs locally).
 * Fallback: a deterministic hashed bag-of-words vector so retrieval degrades gracefully instead
 * of failing. The model id is stored with every vector so vectors from different models are
 * never compared (stale ones are re-embedded lazily).
 */

export const HASH_EMBED_MODEL = "hash-bow-256";
const HASH_DIMS = 256;

let downUntil = 0;

export function embeddingModelName(): string {
  return process.env.EMBEDDING_MODEL ?? "nomic-embed-text";
}

export function hashEmbedding(text: string): number[] {
  const vector = new Array<number>(HASH_DIMS).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (let i = 0; i < tokens.length; i += 1) {
    const grams = [tokens[i], i + 1 < tokens.length ? `${tokens[i]}_${tokens[i + 1]}` : ""];
    for (const gram of grams) {
      if (!gram) continue;
      let hash = 2166136261;
      for (const char of gram) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
      const idx = Math.abs(hash) % HASH_DIMS;
      vector[idx] += hash & 1 ? 1 : -1;
    }
  }
  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
  return norm ? vector.map((v) => v / norm) : vector;
}

export type EmbeddingResult = { model: string; vectors: number[][] };

export async function embedTexts(texts: string[], kind: "query" | "document" = "document"): Promise<EmbeddingResult> {
  if (!texts.length) return { model: HASH_EMBED_MODEL, vectors: [] };
  const disabled = process.env.EMBEDDINGS_ENABLED?.toLowerCase() === "false" || process.env.AI_ENABLED?.toLowerCase() === "false";
  if (!disabled && downUntil <= Date.now()) {
    const model = embeddingModelName();
    const prefix = model.includes("nomic") ? (kind === "query" ? "search_query: " : "search_document: ") : "";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(process.env.EMBEDDING_TIMEOUT_MS ?? 20000));
    try {
      const response = await fetch(`${(process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "")}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ model, input: texts.map((t) => `${prefix}${t}`.slice(0, 4000)), keep_alive: "30m" }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { embeddings?: number[][] };
      if (!body.embeddings || body.embeddings.length !== texts.length) throw new Error("embedding count mismatch");
      return { model, vectors: body.embeddings };
    } catch (error) {
      downUntil = Date.now() + 60000;
      console.warn("Embedding model unavailable, using hashed fallback:", error instanceof Error ? error.message : error);
    } finally {
      clearTimeout(timer);
    }
  }
  return { model: HASH_EMBED_MODEL, vectors: texts.map(hashEmbedding) };
}

export async function embedOne(text: string, kind: "query" | "document" = "document"): Promise<{ model: string; vector: number[] }> {
  const result = await embedTexts([text], kind);
  return { model: result.model, vector: result.vectors[0] ?? [] };
}

/**
 * Hosted embeddings (for when Ollama is gone): OpenRouter /embeddings (e.g. nvidia/nemotron-3.5-embed-8b:free) or
 * Gemini batchEmbedContents (e.g. gemini-embedding-2). Masked text only; plain fetch. Not used by the app unless
 * EMBEDDING_PROVIDER names one (the benchmark decides; default: Ollama nomic-embed-text, then the hashed fallback).
 */
export async function embedHosted(provider: "openrouter" | "gemini", model: string, texts: string[], kind: "query" | "document" = "document", timeoutMs = 20000, pauseMs = 0): Promise<number[][]> {
  const { maskForProvider } = await import("../lib/mask.js");
  const input = texts.map((t) => maskForProvider(t).slice(0, 2000));
  if (provider === "openrouter") {
    if (!model.endsWith(":free")) throw new Error("openrouter embeddings: free models only ($0 cap)");
    const r = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}` },
      body: JSON.stringify({ model, input, encoding_format: "float" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`openrouter embeddings HTTP ${r.status}`);
    const body = (await r.json()) as { data?: Array<{ embedding: number[]; index?: number }>; usage?: { cost?: number } };
    if ((body.usage?.cost ?? 0) > 0) throw new Error("openrouter embeddings reported a cost: stopped ($0 cap)");
    const rows = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (rows.length !== texts.length) throw new Error("openrouter embeddings: count mismatch");
    return rows.map((d) => d.embedding);
  }
  const out: number[][] = [];
  for (let i = 0; i < input.length; i += 100) {
    // Free tiers refuse batches sent back to back (HTTP 429): a pause between them for bulk use.
    if (i && pauseMs) await new Promise((res) => setTimeout(res, pauseMs));
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" },
      body: JSON.stringify({ requests: input.slice(i, i + 100).map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] }, taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT" })) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`gemini embeddings HTTP ${r.status}`);
    const body = (await r.json()) as { embeddings?: Array<{ values: number[] }> };
    out.push(...(body.embeddings ?? []).map((e) => e.values));
  }
  if (out.length !== texts.length) throw new Error("gemini embeddings: count mismatch");
  return out;
}
