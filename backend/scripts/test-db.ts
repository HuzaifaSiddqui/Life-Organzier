/**
 * Creates/updates the test database: runs the Prisma migrations against TEST_DATABASE_URL (never DATABASE_URL).
 * Usage: npm run test:db
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is not set (backend/.env).");
const name = new URL(url).pathname.replace(/^\//, "");
if (!/test/i.test(name)) throw new Error(`TEST_DATABASE_URL must name a test database (contains "test"); got "${name}".`);
const r = spawnSync("npx", ["prisma", "migrate", "deploy"], { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
process.exit(r.status ?? 1);
