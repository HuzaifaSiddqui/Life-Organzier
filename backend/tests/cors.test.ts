import assert from "node:assert/strict";
import test from "node:test";
import { corsOrigin } from "../src/app.js";

function allows(origin: ReturnType<typeof corsOrigin>, requestOrigin: string | undefined): boolean {
  if (typeof origin !== "function") return Boolean(origin);
  let result = false;
  (origin as (o: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => void)(requestOrigin, (_e, allow) => (result = Boolean(allow)));
  return result;
}

test("cors: allowlist from CORS_ORIGINS, mobile requests without Origin always pass", () => {
  const o = corsOrigin({ CORS_ORIGINS: "https://a.example, https://b.example/" });
  assert.equal(allows(o, "https://a.example"), true);
  assert.equal(allows(o, "https://b.example"), true);
  assert.equal(allows(o, "https://evil.example"), false);
  assert.equal(allows(o, undefined), true);
});

test("cors: no config allows all origins in development, none in production", () => {
  assert.equal(corsOrigin({}), true);
  assert.equal(corsOrigin({ NODE_ENV: "production" }), false);
});
