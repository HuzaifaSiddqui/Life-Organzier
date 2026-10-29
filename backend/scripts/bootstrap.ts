/** Bootstrap confidence intervals for the benchmarks (scripts/bench-providers.ts). */

/** Seeded PRNG (mulberry32): the same intervals on every --rank. */
export function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/**
 * 95% bootstrap interval of the accuracy over items (messages / expected dates): each item scored as its mean over
 * the runs, items resampled with replacement 2000 times (fixed seed). Null when runs scored different item lists.
 */
export function bootstrapCi(runs: number[][], resamples = 2000, seed = 20261029): [number, number] | null {
  if (!runs.length || runs.some((r) => r.length !== runs[0].length) || !runs[0].length) return null;
  const n = runs[0].length;
  const v = Array.from({ length: n }, (_, i) => runs.reduce((a, r) => a + r[i], 0) / runs.length);
  const next = rng(seed);
  const means: number[] = [];
  for (let b = 0; b < resamples; b += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += v[Math.floor(next() * n)];
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * resamples)], means[Math.ceil(0.975 * resamples) - 1]];
}

/**
 * Paired 95% bootstrap interval of accuracy(a) - accuracy(b) on the same items: per item, a's mean over its runs minus
 * b's; items resampled together. Far tighter than comparing two separate intervals. Null when the item lists differ.
 */
export function pairedDiffCi(a: number[][], b: number[][], resamples = 2000, seed = 20261029): { diff: number; ci: [number, number] } | null {
  const n = a[0]?.length ?? 0;
  if (!n || [...a, ...b].some((r) => r.length !== n)) return null;
  const mean = (runs: number[][], i: number) => runs.reduce((s, r) => s + r[i], 0) / runs.length;
  const d = Array.from({ length: n }, (_, i) => mean(a, i) - mean(b, i));
  const next = rng(seed);
  const means: number[] = [];
  for (let k = 0; k < resamples; k += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += d[Math.floor(next() * n)];
    means.push(sum / n);
  }
  means.sort((x, y) => x - y);
  return { diff: d.reduce((s, x) => s + x, 0) / n, ci: [means[Math.floor(0.025 * resamples)], means[Math.ceil(0.975 * resamples) - 1]] };
}
