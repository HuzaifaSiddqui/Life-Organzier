import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AiService, setAi } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import { handleAssistantMessage } from "../src/modules/assistant/dialogue.js";
import { extractEntities, extractLocation, parseLocationCommand } from "../src/modules/assistant/entities.js";
import { resetGeocodeCache } from "../src/modules/locations/geocode.js";
import { createOrFindLocation } from "../src/modules/locations/locationService.js";
import { dbAvailable, opts } from "./fixtures.js";

const skip = !dbAvailable && "no database";
const evalSet = JSON.parse(readFileSync(new URL("./eval/assistant-eval.json", import.meta.url), "utf8")) as { locations: Array<{ id: string; text: string; location: string | null }> };

test("location entity: the eval set rows", () => {
  for (const row of evalSet.locations) assert.equal(extractEntities(row.text, opts).location, row.location, `${row.id}: ${row.text}`);
});

test("location entity: times, people and parts of day are not places", () => {
  for (const text of ["call Ali at 5", "study in the morning", "Ali se baat karni hai", "kal se gym", "Remind me to call Ali tomorrow at 5 PM", "read in bed"]) {
    assert.equal(extractEntities(text, opts).location, null, text);
  }
});

test("location entity: strong and weak markers, Roman Urdu trimming, saved names", () => {
  assert.equal(extractLocation("pick up parcel when I reach COMSATS"), "COMSATS");
  assert.equal(extractLocation("print notes at the library and submit"), "library");
  assert.equal(extractLocation("dawai Ali medical store se lena"), "Ali medical store");
  assert.equal(extractLocation("Liberty Market pohunch ke call karna"), "Liberty Market");
  assert.equal(extractLocation("buy shoes at Packages"), null); // no place word, not saved
  assert.equal(extractLocation("buy shoes at Packages", ["packages"]), "Packages");
  // the title keeps the place: non-Pro users see the same task as before
  assert.equal(extractEntities("buy medicine from Ali Medical Store", opts).residual.includes("Ali Medical Store"), true);
});

test("location commands: remove and change, English and Roman Urdu", () => {
  assert.deepEqual(parseLocationCommand("remove the location"), { kind: "remove", taskRef: "" });
  assert.deepEqual(parseLocationCommand("Remove location from buy medicine"), { kind: "remove", taskRef: "buy medicine" });
  assert.deepEqual(parseLocationCommand("location hata do"), { kind: "remove", taskRef: "" });
  assert.deepEqual(parseLocationCommand("dawai ki jagah hata do"), { kind: "remove", taskRef: "dawai" });
  assert.deepEqual(parseLocationCommand("change the location to Liberty Market"), { kind: "change", taskRef: "", place: "Liberty Market" });
  assert.deepEqual(parseLocationCommand("change the location of groceries to Model Town"), { kind: "change", taskRef: "groceries", place: "Model Town" });
  assert.deepEqual(parseLocationCommand("jagah badal do"), { kind: "change", taskRef: "", place: null });
  assert.equal(parseLocationCommand("buy medicine from Ali Medical Store"), null);
});

async function withUser(tier: "FREE" | "PRO", fn: (say: (text: string) => ReturnType<typeof handleAssistantMessage>, userId: string) => Promise<void>) {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, tier, timezone: "Asia/Karachi" } });
  try {
    const say = async (text: string) => handleAssistantMessage({ user, settings: (await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }))!, deviceId: null, text, channel: "APP" });
    await fn(say, user.id);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
}

const linkedPlaces = async (userId: string) =>
  (await prisma.taskLocation.findMany({ where: { task: { userId } }, include: { savedLocation: true } })).map((l) => l.savedLocation.name);

test("chat: Pro user's saved place is attached; 'ghar' finds Home; remove and change", { skip }, async () => {
  await withUser("PRO", async (say, userId) => {
    await createOrFindLocation(userId, { name: "Ali Medical Store", latitude: 31.5, longitude: 74.3, preset: "PRECISE" });
    await createOrFindLocation(userId, { name: "Home", latitude: 31.52, longitude: 74.35 });
    let r = await say("buy medicine from Ali Medical Store tomorrow");
    assert.match(r.message.content, /Location set: Ali Medical Store \(Precise range\)/);
    assert.deepEqual(await linkedPlaces(userId), ["Ali Medical Store"]);

    r = await say("remove the location");
    assert.match(r.message.content, /Location removed from/);
    assert.deepEqual(await linkedPlaces(userId), []);

    r = await say("ghar ja ke nails cut karna kal");
    assert.match(r.message.content, /Location set: Home/);
    r = await say("change the location to Ali Medical Store");
    assert.match(r.message.content, /Location set: Ali Medical Store/);
    assert.deepEqual((await linkedPlaces(userId)).sort(), ["Ali Medical Store"]);
  });
});

test("chat: free users get no geofence and no location wording", { skip }, async () => {
  await withUser("FREE", async (say, userId) => {
    await createOrFindLocation(userId, { name: "Ali Medical Store", latitude: 31.5, longitude: 74.3 });
    const r = await say("buy medicine from Ali Medical Store tomorrow");
    assert.doesNotMatch(r.message.content, /Location|map/);
    assert.deepEqual(await linkedPlaces(userId), []);
    const cmd = await say("remove the location");
    assert.match(cmd.message.content, /Pro/);
  });
});

test("location entity: Roman Urdu aliases are extracted as said", () => {
  assert.equal(extractEntities("ghar ja ke medicine lana", opts).location, "ghar");
  assert.equal(extractEntities("daftar se nikal ke file lena", opts).location, "daftar");
});

/** Replaces Nominatim with fixed rows for one test. */
async function withNominatim(rows: Array<{ name: string; display_name: string; lat: string; lon: string }>, fn: () => Promise<void>) {
  const real = globalThis.fetch;
  resetGeocodeCache();
  globalThis.fetch = (async () => new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
    resetGeocodeCache();
  }
}

const branch = (area: string, i: number) => ({ name: "Fazal Din Pharma Plus", display_name: `Fazal Din Pharma Plus, ${area}, Lahore, Pakistan`, lat: String(31.5 + i / 100), lon: String(74.3 + i / 100) });

test("chat: aliases find saved places (ghar → Home, daftar → Office)", { skip }, async () => {
  await withUser("PRO", async (say, userId) => {
    await createOrFindLocation(userId, { name: "Home", latitude: 31.52, longitude: 74.35 });
    await createOrFindLocation(userId, { name: "Office", latitude: 31.48, longitude: 74.4 });
    assert.match((await say("ghar ja ke medicine lana kal")).message.content, /Location set: Home/);
    assert.match((await say("daftar se file lena kal")).message.content, /Location set: Office/);
    assert.deepEqual((await linkedPlaces(userId)).sort(), ["Home", "Office"]);
  });
});

test("chat: several map results → numbered choice; '2' attaches that branch", { skip }, async () => {
  await withNominatim([branch("Model Town", 0), branch("Johar Town", 1), branch("DHA Phase 5", 2)], async () => {
    await withUser("PRO", async (say, userId) => {
      const r = await say("buy medicine from fazal din pharmacy tomorrow");
      assert.match(r.message.content, /I found several locations for 'fazal din pharmacy'/);
      assert.match(r.message.content, /1\. Fazal Din Pharma Plus, Model Town[\s\S]*2\. Fazal Din Pharma Plus, Johar Town[\s\S]*3\. /);
      assert.doesNotMatch(r.message.content, /4\. /);
      assert.deepEqual(await linkedPlaces(userId), []);

      const pick = await say("2");
      assert.match(pick.message.content, /Location set: Fazal Din Pharma Plus, Johar Town/);
      const saved = await prisma.savedLocation.findFirstOrThrow({ where: { userId } });
      assert.equal(saved.name, "Fazal din pharmacy");
      assert.match(saved.displayAddress ?? "", /Johar Town/);
      assert.equal(saved.latitude, 31.51);
      assert.deepEqual(await linkedPlaces(userId), ["Fazal din pharmacy"]);
    });
  });
});

test("chat: 'none' skips the location and clears the question; 5 results offer 'open task'", { skip }, async () => {
  await withNominatim([branch("Model Town", 0), branch("Johar Town", 1), branch("DHA", 2), branch("Gulberg", 3), branch("Cantt", 4)], async () => {
    await withUser("PRO", async (say, userId) => {
      const r = await say("buy medicine from fazal din pharmacy tomorrow");
      assert.match(r.message.content, /4\. Fazal Din Pharma Plus, Gulberg[\s\S]*5\. Open task to search/);
      assert.match((await say("none")).message.content, /No location set/);
      const conv = await prisma.conversation.findFirstOrThrow({ where: { userId } });
      assert.equal((conv.state as { pending: unknown }).pending, null);
      assert.deepEqual(await linkedPlaces(userId), []);

      await say("buy bandages from fazal din pharmacy tomorrow");
      assert.match((await say("5")).message.content, /Open 'Buy bandages[^']*' and tap 'Add location'/);
      assert.deepEqual(await linkedPlaces(userId), []);
    });
  });
});
