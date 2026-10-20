import { describe, expect, it } from "vitest";
import type { SavedLocation } from "../../types/models";
import { distanceM } from "../geofence";
import { clampLatitude, clampLongitude, clampZoom, commandScript, defaultCenter, homePlace, initialCenter, isCoords, parseMapMessage, presetRadius, PRESET_RADIUS_M } from "../map";

const place = (name: string, latitude = 31.5, longitude = 74.3): SavedLocation => ({ id: name, name, latitude, longitude, preset: "NEARBY", radiusM: 350, usageCount: 0, displayAddress: null }) as SavedLocation;

describe("radius presets", () => {
  it("maps each preset to metres; unknown or missing is Nearby", () => {
    expect(PRESET_RADIUS_M).toEqual({ PRECISE: 200, NEARBY: 350, AREA: 750 });
    expect(presetRadius("AREA")).toBe(750);
    expect(presetRadius(null)).toBe(350);
    expect(presetRadius("WHATEVER" as never)).toBe(350);
  });
});

describe("coordinates", () => {
  it("clamps latitude to the map, wraps longitude and rounds zoom into range", () => {
    expect(clampLatitude(89)).toBe(85);
    expect(clampLatitude(-120)).toBe(-85);
    expect(clampLongitude(190)).toBe(-170);
    expect(clampLongitude(-181)).toBe(179);
    expect(clampLongitude(74.3)).toBeCloseTo(74.3);
    expect(clampZoom(25)).toBe(19);
    expect(clampZoom(0.4)).toBe(2);
    expect(clampZoom(15.6)).toBe(16);
  });
  it("accepts only finite, in-range coordinates", () => {
    expect(isCoords({ latitude: 31.5, longitude: 74.3 })).toBe(true);
    expect(isCoords({ latitude: 91, longitude: 0 })).toBe(false);
    expect(isCoords({ latitude: Number.NaN, longitude: 0 })).toBe(false);
    expect(isCoords(null)).toBe(false);
  });
  it("distance between two points (reused from the geofence rules)", () => {
    const d = distanceM({ latitude: 31.5204, longitude: 74.3587 }, { latitude: 31.5204, longitude: 74.3624 });
    expect(d).toBeGreaterThan(330);
    expect(d).toBeLessThan(370);
  });
});

describe("map → app messages", () => {
  it("parses the known events", () => {
    expect(parseMapMessage('{"type":"ready"}')).toEqual({ type: "ready" });
    expect(parseMapMessage('{"type":"pinMoved","latitude":31.52,"longitude":74.35}')).toEqual({ type: "pinMoved", latitude: 31.52, longitude: 74.35 });
    expect(parseMapMessage('{"type":"markerTapped","id":"r-2"}')).toEqual({ type: "markerTapped", id: "r-2" });
    expect(parseMapMessage('{"type":"tilesFailed"}')).toEqual({ type: "tilesFailed" });
  });
  it("rejects anything malformed", () => {
    for (const bad of [
      "not json",
      "null",
      '"ready"',
      '{"type":"evil"}',
      '{"type":"pinMoved","latitude":"31","longitude":74}',
      '{"type":"pinMoved","latitude":95,"longitude":74}',
      '{"type":"pinMoved","latitude":31}',
      '{"type":"markerTapped","id":""}',
      `{"type":"markerTapped","id":"${"x".repeat(101)}"}`,
      42,
      `{"type":"ready","pad":"${"x".repeat(3000)}"}`,
    ]) {
      expect(parseMapMessage(bad)).toBeNull();
    }
  });
  it("wraps out-of-range longitudes that pass validation edges", () => {
    expect(parseMapMessage('{"type":"pinMoved","latitude":88,"longitude":180}')).toEqual({ type: "pinMoved", latitude: 85, longitude: -180 });
  });
});

describe("app → map commands", () => {
  it("JSON-encodes values, so a name can't break out of the script", () => {
    const js = commandScript({ type: "setMarkers", markers: [{ id: "a", label: '"); alert(1); ("', latitude: 1, longitude: 2, kind: "result" }] });
    expect(js.startsWith("window.__lo && window.__lo({")).toBe(true);
    expect(js).toContain('\\"); alert(1); (\\"');
    expect(js.endsWith("true;")).toBe(true);
  });
});

describe("where the map opens", () => {
  it("current position first, then the saved Home, then the timezone default", () => {
    const here = { latitude: 24.86, longitude: 67.0 };
    expect(initialCenter({ current: here, saved: [place("Home")], timeZone: "Asia/Karachi" })).toEqual({ ...here, zoom: 16 });
    expect(initialCenter({ current: null, saved: [place("Uni"), place("ghar", 31.6, 74.4)], timeZone: "Asia/Karachi" })).toEqual({ latitude: 31.6, longitude: 74.4, zoom: 15 });
    expect(initialCenter({ current: null, saved: [], timeZone: "Asia/Karachi" }).zoom).toBe(5);
    expect(defaultCenter("Mars/Olympus")).toEqual({ latitude: 20, longitude: 0, zoom: 2 });
    expect(homePlace([place(" HOME ")])?.name).toBe(" HOME ");
  });
});
