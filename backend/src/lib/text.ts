const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "with", "from", "this", "that", "task", "my", "to", "of", "in", "on",
  "at", "by", "is", "it", "be", "me", "i", "do", "please", "can", "you", "your", "our", "some", "about",
]);

export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function stem(word: string): string {
  return word.length > 4 ? word.replace(/(ing|ed|es|s)$/i, "") : word;
}

export function contentTokens(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

function trigrams(value: string): Set<string> {
  const s = `  ${normalizeText(value)} `;
  const out = new Set<string>();
  for (let i = 0; i < s.length - 2; i += 1) out.add(s.slice(i, i + 3));
  return out;
}

/** 0..1 similarity robust to typos (trigram Jaccard) and word overlap. */
export function fuzzySimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const jaccard = ta.size + tb.size - inter > 0 ? inter / (ta.size + tb.size - inter) : 0;
  const wa = new Set(contentTokens(a));
  const wb = new Set(contentTokens(b));
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap += 1;
  const wordScore = wa.size && wb.size ? overlap / Math.min(wa.size, wb.size) : 0;
  return Math.max(jaccard, wordScore * 0.9);
}

/** Levenshtein distance for typo correction (FR-EH-003). */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[n];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
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

export function titleCase(value: string): string {
  const t = value.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

export function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!m) return `${h} ${h === 1 ? "hour" : "hours"}`;
  return `${h}h ${m}m`;
}
