/**
 * Probes every candidate at once and returns the first one, in list (priority) order, that answered.
 * Total wait is the slowest probe (each probe owns its timeout), not the sum of all probes.
 */
export async function firstReachableInOrder(
  candidates: string[],
  probe: (candidate: string) => Promise<boolean>
): Promise<string | null> {
  const results = await Promise.all(candidates.map((c) => probe(c).catch(() => false)));
  const index = results.findIndex(Boolean);
  return index === -1 ? null : candidates[index];
}
