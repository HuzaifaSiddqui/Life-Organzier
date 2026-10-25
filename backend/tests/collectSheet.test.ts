import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getCommand } from "../src/modules/assistant/commands/registry.js";
import { parseSheet } from "../scripts/collect-to-holdout.js";

const sheet = readFileSync(new URL("./eval/collect-sheet.md", import.meta.url), "utf8");

test("collect sheet: 12 labelled scenarios with real commands and one free one; the blank sheet gives no rows", () => {
  const tags = [...sheet.matchAll(/<!--\s*scenario:\s*(\S+)\s+command:\s*(\S+)\s*-->/g)].map((m) => [m[1], m[2]]);
  assert.equal(tags.length, 13);
  assert.deepEqual(tags.filter(([, c]) => c === "none").map(([s]) => s), ["S13"]);
  for (const [s, c] of tags) if (c !== "none") assert.ok(getCommand(c), `${s}: ${c} is a command`);
  assert.deepEqual(parseSheet(sheet), []);
});

test("collect sheet: a filled sheet gives each message its scenario's command and its list's language", () => {
  const filled = sheet
    .replace("## S01 · Add something to do, with a day and a time\n<!-- scenario: S01 command: create_task -->", (m) => m)
    .replace(/(<!-- scenario: S01 command: create_task -->[\s\S]*?\*\*English\*\*\n)-\n/, "$1- lab report thursday 11pm\n- remind me abt the lab report on thu night\n")
    .replace(/(<!-- scenario: S01 command: create_task -->[\s\S]*?\*\*Roman Urdu\*\*\n)-\n/, "$1- jumeraat raat 11 baje lab report jama karni hai\n")
    .replace(/(<!-- scenario: S13 command: none -->[\s\S]*?\*\*English\*\*\n)-\n/, "$1- remind me to drink water every hour (repeats every hour)\n");
  assert.deepEqual(parseSheet(filled), [
    { scenario: "S01", command: "create_task", lang: "en", text: "lab report thursday 11pm" },
    { scenario: "S01", command: "create_task", lang: "en", text: "remind me abt the lab report on thu night" },
    { scenario: "S01", command: "create_task", lang: "ru", text: "jumeraat raat 11 baje lab report jama karni hai" },
    { scenario: "S13", command: null, lang: "en", text: "remind me to drink water every hour (repeats every hour)" },
  ]);
});
