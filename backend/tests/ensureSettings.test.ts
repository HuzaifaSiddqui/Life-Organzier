import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { prisma } from "../src/config/db.js";
import { ensureSettings } from "../src/lib/http.js";
import { dbAvailable } from "./fixtures.js";

const skip = !dbAvailable && "no database";

test("ensureSettings: a new account's parallel first requests all get the one settings row (no unique-constraint error)", { skip }, async () => {
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  try {
    const rows = await Promise.all(Array.from({ length: 12 }, () => ensureSettings(user.id)));
    assert.equal(new Set(rows.map((r) => r.id)).size, 1, "one row, returned to every request");
    assert.equal(await prisma.userSettings.count({ where: { userId: user.id } }), 1);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});
