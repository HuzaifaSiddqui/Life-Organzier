import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Lint for the action contract (docs/chat-failures.md): no button object in backend/src may have a label and a
 * text but no payload. The QuickAction type already requires a payload; this also catches objects the type check
 * can't see (casts, untyped arrays, JSON built by hand). Fix a hit with commandAction / sayAction / answerAction
 * from assistant/actions.ts.
 */
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** Every `{ … label: … }` object literal (balanced braces), with its line number. */
function labelObjects(source: string): Array<{ body: string; line: number }> {
  const out: Array<{ body: string; line: number }> = [];
  const re = /\{\s*label\s*:/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let depth = 0;
    let end = m.index;
    for (; end < source.length; end += 1) {
      if (source[end] === "{") depth += 1;
      else if (source[end] === "}" && --depth === 0) break;
    }
    out.push({ body: source.slice(m.index, end + 1), line: source.slice(0, m.index).split("\n").length });
  }
  return out;
}

test("no button in backend/src has a text without a payload", () => {
  const hits: string[] = [];
  for (const file of files(SRC)) {
    const source = readFileSync(file, "utf8");
    for (const o of labelObjects(source)) {
      if (/\btext\s*:/.test(o.body) && !/\bpayload\b/.test(o.body)) hits.push(`${relative(SRC, file)}:${o.line}  ${o.body.replace(/\s+/g, " ").slice(0, 100)}`);
    }
  }
  assert.deepEqual(hits, [], `Buttons without a payload (use commandAction / sayAction / answerAction):\n${hits.join("\n")}`);
});

test("the lint finds a text-only button", () => {
  assert.equal(labelObjects('actions: [{ label: "Show", text: "Show my tasks" }]').length, 1);
  const [o] = labelObjects('x = { label: "Show", text: "Show my tasks" };');
  assert.ok(/\btext\s*:/.test(o.body) && !/\bpayload\b/.test(o.body));
});
