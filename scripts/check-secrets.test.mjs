import assert from "node:assert/strict";
import test from "node:test";
import { scan } from "./check-secrets.mjs";

// Fake keys are built at runtime so this file does not trip the scanner itself.
const fake = (prefix) => prefix + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

test("key-like strings are found, and only kind + line are reported", () => {
  const found = scan("backend/src/x.ts", `const a = 1;\nconst k = "${fake("gsk_")}";\nfetch(u, { key: "${fake("sk-or-v1-")}" })`);
  assert.deepEqual(found, [{ line: 2, kind: "groq" }, { line: 3, kind: "openrouter" }]);
  assert.ok(!JSON.stringify(found).includes("A1b2"), "never the value");
});

test(".env.example: names with empty or placeholder values pass; a real-looking value fails", () => {
  const ok = 'GROQ_API_KEY=""\nTWILIO_AUTH_TOKEN=\nDATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DATABASE"\n# WHATSAPP_KEY_SECRET=""\nFIREBASE_PRIVATE_KEY=""';
  assert.deepEqual(scan("backend/.env.example", ok), []);
  const bad = scan("backend/.env.example", 'DEPLOY_API_KEY_1="dk_live_9f8e7d6c5b4a39281706f5e4d3c2b1a0"');
  assert.equal(bad.length, 1);
  assert.match(bad[0].kind, /DEPLOY_API_KEY_1/);
});

test("ordinary code is clean", () => {
  assert.deepEqual(scan("a.ts", 'const token = req.headers.authorization; // "Bearer " + id\nprocess.env.GROQ_API_KEY'), []);
});
