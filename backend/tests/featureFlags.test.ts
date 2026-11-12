import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FEATURE_FLAGS, NOT_FLAGS } from "./setup.js";

test("feature flags: every flag starts blank (default) in tests, whatever backend/.env or the shell says", () => {
  const set = FEATURE_FLAGS.filter((f) => process.env[f]);
  assert.deepEqual(set, [], "tests/setup.ts blanks every feature flag");
});

test("feature flags: every on/off setting in .env.example is in the list (a new flag can't leak into tests)", () => {
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  const switches = [...example.matchAll(/^([A-Z0-9_]+)=(?:on|off|true|false)\b/gm)].map((m) => m[1]);
  const known = new Set<string>([...FEATURE_FLAGS, ...NOT_FLAGS]);
  assert.deepEqual([...new Set(switches.filter((k) => !known.has(k)))], [], "add it to FEATURE_FLAGS (or NOT_FLAGS) in tests/setup.ts");
});
