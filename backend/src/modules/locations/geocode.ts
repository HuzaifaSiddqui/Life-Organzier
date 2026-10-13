/**
 * FR-LB-001 geocoding through OpenStreetMap Nominatim (free). Called only from the backend; the phone
 * never talks to Nominatim. Usage policy: a real User-Agent, at most 1 request per second, cache results.
 */

export type GeoResult = { name: string; displayName: string; latitude: number; longitude: number };

const BASE = (process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org").replace(/\/$/, "");
const USER_AGENT = "LifeOrganizer/1.0 (FYP)";
const TTL_MS = 24 * 3600 * 1000;
const MIN_GAP_MS = 1000;

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// ponytail: in-memory cache and queue, per server process; fine for one backend instance.
const cache = new Map<string, { at: number; value: unknown }>();
let chain: Promise<unknown> = Promise.resolve();
let lastCall = 0;

/** Runs Nominatim calls one at a time, at least 1 s apart. */
function throttled<T>(fn: () => Promise<T>, now: () => number, sleep: (ms: number) => Promise<void>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastCall + MIN_GAP_MS - now();
    if (wait > 0) await sleep(wait);
    lastCall = now();
    return fn();
  });
  chain = run.catch(() => undefined);
  return run;
}

export type GeocodeDeps = { fetch?: Fetch; now?: () => number; sleep?: (ms: number) => Promise<void> };

async function cachedGet(url: string, deps: GeocodeDeps): Promise<unknown> {
  const now = deps.now ?? Date.now;
  const hit = cache.get(url);
  if (hit && now() - hit.at < TTL_MS) return hit.value;
  const doFetch = deps.fetch ?? (fetch as unknown as Fetch);
  const value = await throttled(
    async () => {
      const res = await doFetch(url, { headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Nominatim ${res.status}`);
      return res.json();
    },
    now,
    deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  );
  cache.set(url, { at: now(), value });
  return value;
}

type NominatimPlace = { name?: string; display_name?: string; lat?: string; lon?: string };

function toResult(p: NominatimPlace): GeoResult | null {
  const latitude = Number(p.lat);
  const longitude = Number(p.lon);
  if (!p.display_name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { name: p.name || p.display_name.split(",")[0].trim(), displayName: p.display_name, latitude, longitude };
}

/** Forward search, max 5 results, biased (not limited) to ~25 km around `near` when given. Empty on any failure. */
export async function geocode(q: string, near: { lat: number; lng: number } | null, deps: GeocodeDeps = {}): Promise<GeoResult[]> {
  const params = new URLSearchParams({ q: q.trim(), format: "jsonv2", limit: "5", addressdetails: "0" });
  if (near) {
    const d = 0.25; // ≈ 25 km box around the user
    params.set("viewbox", `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`);
  }
  try {
    const rows = (await cachedGet(`${BASE}/search?${params}`, deps)) as NominatimPlace[];
    return (Array.isArray(rows) ? rows : []).map(toResult).filter((r): r is GeoResult => r !== null).slice(0, 5);
  } catch (error) {
    console.warn("Geocoding failed", error instanceof Error ? error.message : error);
    return [];
  }
}

/** Reverse lookup for "Use current location": a readable name for coordinates, or null. */
export async function reverseGeocode(lat: number, lng: number, deps: GeocodeDeps = {}): Promise<GeoResult | null> {
  // ~11 m rounding keeps the cache useful without changing the place found.
  const params = new URLSearchParams({ lat: lat.toFixed(4), lon: lng.toFixed(4), format: "jsonv2", zoom: "18" });
  try {
    const row = (await cachedGet(`${BASE}/reverse?${params}`, deps)) as NominatimPlace;
    const r = toResult(row ?? {});
    return r ? { ...r, latitude: lat, longitude: lng } : null;
  } catch (error) {
    console.warn("Reverse geocoding failed", error instanceof Error ? error.message : error);
    return null;
  }
}

/** Test hook. */
export function resetGeocodeCache(): void {
  cache.clear();
  lastCall = 0;
  chain = Promise.resolve();
}
