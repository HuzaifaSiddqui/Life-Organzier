import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type * as MobileMap from "../../mobile/src/utils/map.js";
import { PRESETS } from "../src/modules/locations/locationService.js";

// The phone draws the radius circle from its own copy of the preset sizes; they must match what the server stores.
const { PRESET_RADIUS_M } = createRequire(import.meta.url)("../../mobile/src/utils/map.ts") as typeof MobileMap;

test("radius presets: the phone's map circle and the server's geofence radius are the same metres", () => {
  assert.deepEqual(PRESET_RADIUS_M, { ...PRESETS });
});
