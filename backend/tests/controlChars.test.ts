import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

/** Source files must not hide control characters (a "\b" typed as a real backspace makes a regex silently never match). */
const ROOT = resolve(import.meta.dirname, "../..");
const DIRS = ["backend/src", "mobile/src"];
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/; // all but tab, newline, carriage return

/** Known lines, removed by the storeInfo fix (from bd855f2). Matched by file and exact text, so nothing else slips in. */
const ALLOWED = new Set([
  `backend/src/modules/assistant/dialogue.ts:    .replace(/\bthe user's\b/gi, "your")`,
  `backend/src/modules/assistant/dialogue.ts:    .replace(/\bthe user\b/gi, "you")`,
  `backend/src/modules/assistant/dialogue.ts:    .replace(/\byou is\b/gi, "you are");`,
]);

test("no control characters (other than tab, newline, carriage return) in backend/src or mobile/src", () => {
  const found: string[] = [];
  for (const dir of DIRS) {
    for (const entry of readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:[cm]?[jt]sx?|json)$/.test(entry.name)) continue;
      const file = relative(ROOT, join(entry.parentPath, entry.name)).split("\\").join("/");
      readFileSync(join(entry.parentPath, entry.name), "utf8").split("\n").forEach((line, i) => {
        const text = line.replace(/\r$/, "");
        if (CONTROL.test(text) && !ALLOWED.has(`${file}:${text}`)) found.push(`${file}:${i + 1} ${JSON.stringify(text.trim())}`);
      });
    }
  }
  assert.deepEqual(found, [], "control characters found (write \\b, not a real backspace)");
});
