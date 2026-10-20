import type { SavedLocation } from "../types/models";

/**
 * Pure helpers for the map place picker (FR-LB-001): radius presets, coordinate checks, and the message
 * protocol between the app and the WebView map. Unit-tested in __tests__/map.test.ts.
 */

export type Coords = { latitude: number; longitude: number };
export type Center = Coords & { zoom: number };
export type Preset = SavedLocation["preset"];

/** Radius of each preset in metres (the server stores the same values). */
export const PRESET_RADIUS_M: Record<Preset, number> = { PRECISE: 200, NEARBY: 350, AREA: 750 };

export function presetRadius(preset: Preset | null | undefined): number {
  return PRESET_RADIUS_M[preset ?? "NEARBY"] ?? PRESET_RADIUS_M.NEARBY;
}

export const clampLatitude = (v: number) => Math.max(-85, Math.min(85, v)); // Web Mercator stops at ±85°
/** Wraps into [-180, 180); values already in range are returned exactly (no float drift). */
export const clampLongitude = (v: number) => (v >= -180 && v < 180 ? v : ((((v + 180) % 360) + 360) % 360) - 180);
export const clampZoom = (z: number) => Math.max(2, Math.min(19, Math.round(z)));

export function isCoords(v: unknown): v is Coords {
  const c = v as Coords;
  return !!c && Number.isFinite(c.latitude) && Number.isFinite(c.longitude) && Math.abs(c.latitude) <= 90 && Math.abs(c.longitude) <= 180;
}

/* ------------------------------------------------------------------ map → app */

export type MapEvent =
  | { type: "ready" }
  | { type: "pinMoved"; latitude: number; longitude: number }
  | { type: "markerTapped"; id: string }
  | { type: "tilesLoaded" }
  | { type: "tilesFailed" };

/**
 * Parses a message from the WebView. Anything malformed (not JSON, unknown type, out-of-range or non-numeric
 * coordinates, an over-long id) is rejected with null, so the page can never push bad data into the app.
 */
export function parseMapMessage(raw: unknown): MapEvent | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  switch (m.type) {
    case "ready":
    case "tilesLoaded":
    case "tilesFailed":
      return { type: m.type };
    case "pinMoved": {
      const c = { latitude: Number(m.latitude), longitude: Number(m.longitude) };
      if (typeof m.latitude !== "number" || typeof m.longitude !== "number" || !isCoords(c)) return null;
      return { type: "pinMoved", latitude: clampLatitude(c.latitude), longitude: clampLongitude(c.longitude) };
    }
    case "markerTapped":
      return typeof m.id === "string" && m.id.length > 0 && m.id.length <= 100 ? { type: "markerTapped", id: m.id } : null;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ app → map */

export type MapMarker = Coords & { id: string; label: string; kind: "saved" | "result" };

export type MapCommand =
  | ({ type: "setCenter" } & Center)
  | ({ type: "setPin" } & Coords)
  | { type: "clearPin" }
  | { type: "setRadius"; meters: number }
  | { type: "setMarkers"; markers: MapMarker[] };

/** JavaScript to inject into the map page for one command (values are JSON-encoded, never concatenated). */
export function commandScript(cmd: MapCommand): string {
  return `window.__lo && window.__lo(${JSON.stringify(cmd)}); true;`;
}

/* ------------------------------------------------------------------ where the map opens */

/** A sensible first view per timezone when there is no position and no saved Home (country-level zoom). */
const TIMEZONE_CENTERS: Record<string, Center> = {
  "Asia/Karachi": { latitude: 30.3753, longitude: 69.3451, zoom: 5 },
  "Asia/Kolkata": { latitude: 22.3511, longitude: 78.6677, zoom: 4 },
  "Asia/Dubai": { latitude: 24.4539, longitude: 54.3773, zoom: 7 },
  "Asia/Riyadh": { latitude: 23.8859, longitude: 45.0792, zoom: 5 },
  "Europe/London": { latitude: 54.0, longitude: -2.5, zoom: 5 },
  "America/New_York": { latitude: 40.7128, longitude: -74.006, zoom: 6 },
};
const WORLD: Center = { latitude: 20, longitude: 0, zoom: 2 };

export function defaultCenter(timeZone: string | null | undefined): Center {
  return (timeZone && TIMEZONE_CENTERS[timeZone]) || WORLD;
}

/**
 * A view that shows all the places: their middle, zoomed out until the farthest one fits
 * (roughly: within 1 km → 15, 5 km → 13, 20 km → 11, 100 km → 9, else 6). Null without places.
 */
export function centerForPlaces(places: Coords[], distance: (a: Coords, b: Coords) => number): Center | null {
  const valid = places.filter(isCoords);
  if (!valid.length) return null;
  const mid = { latitude: valid.reduce((s, p) => s + p.latitude, 0) / valid.length, longitude: valid.reduce((s, p) => s + p.longitude, 0) / valid.length };
  const far = Math.max(...valid.map((p) => distance(mid, p)));
  const zoom = far < 1000 ? 15 : far < 5000 ? 13 : far < 20000 ? 11 : far < 100000 ? 9 : 6;
  return { ...mid, zoom };
}

const HOME_NAMES = ["home", "ghar", "گھر"];

export function homePlace(saved: SavedLocation[]): SavedLocation | null {
  return saved.find((p) => HOME_NAMES.includes(p.name.trim().toLowerCase())) ?? null;
}

/** The current position, else the saved Home, else the timezone's default. Street zoom when a point is known. */
export function initialCenter(opts: { current: Coords | null; saved: SavedLocation[]; timeZone: string | null | undefined }): Center {
  if (opts.current && isCoords(opts.current)) return { ...opts.current, zoom: 16 };
  const home = homePlace(opts.saved);
  if (home) return { latitude: home.latitude, longitude: home.longitude, zoom: 15 };
  return defaultCenter(opts.timeZone);
}
