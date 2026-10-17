/**
 * Runs before every test file (npm test: --import ./tests/setup.ts).
 *
 * - Tests use TEST_DATABASE_URL, never the development database. Before this, Prisma Client loaded
 *   backend/.env by itself, so tests wrote to whatever DATABASE_URL pointed at (the dev database).
 *   npm test refuses to run without TEST_DATABASE_URL, or if its database name doesn't contain "test".
 * - No real WhatsApp messages or pushes: Twilio and Expo credentials are blanked (blank, not deleted, so
 *   Prisma's own .env loading can't fill them back in) and any request to their hosts throws.
 */
import { existsSync, readFileSync } from "node:fs";
import { parse } from "dotenv";

const envFile = new URL("../.env", import.meta.url);
const fromFile = existsSync(envFile) ? parse(readFileSync(envFile)) : {};

const testUrl = process.env.TEST_DATABASE_URL || fromFile.TEST_DATABASE_URL;
if (!testUrl) {
  throw new Error("TEST_DATABASE_URL is not set. Add a separate test database to backend/.env (see .env.example), then run `npm run test:db`.");
}
const dbName = new URL(testUrl).pathname.replace(/^\//, "");
if (!/test/i.test(dbName)) {
  throw new Error(`TEST_DATABASE_URL must point at a test database (its name must contain "test"); got "${dbName}". Refusing to run tests.`);
}
process.env.DATABASE_URL = testUrl;

for (const key of new Set([...Object.keys(process.env), ...Object.keys(fromFile)])) {
  if (/^(?:TWILIO_|EXPO_)/.test(key)) process.env[key] = "";
}

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^https?:\/\/(?:[\w-]+\.)*(?:twilio\.com|exp\.host|expo\.dev)(?:[:/]|$)/i.test(url)) {
    throw new Error(`A test tried to call ${new URL(url).host} for real.`);
  }
  return realFetch(input, init);
}) as typeof fetch;
