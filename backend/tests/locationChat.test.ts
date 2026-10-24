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

async function withUser(tier: "FREE" | "PRO", fn: (say: (text: string, locationReminders?: boolean) => ReturnType<typeof handleAssistantMessage>, userId: string) => Promise<void>) {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, tier, timezone: "Asia/Karachi" } });
  try {
    const say = async (text: string, locationReminders?: boolean) => handleAssistantMessage({ user, settings: (await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }))!, deviceId: null, text, channel: "APP", locationReminders });
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

test("chat: free users get no geofence, only the invitation to Pro + Location reminders", { skip }, async () => {
  await withUser("FREE", async (say, userId) => {
    await createOrFindLocation(userId, { name: "Ali Medical Store", latitude: 31.5, longitude: 74.3 });
    const r = await say("buy medicine from Ali Medical Store tomorrow");
    assert.doesNotMatch(r.message.content, /Location set|map/);
    assert.match(r.message.content, /Location reminders come with Pro/);
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

const setupCard = (r: Awaited<ReturnType<typeof handleAssistantMessage>>) => r.message.cards?.find((c) => c.type === "location_setup");

test("chat (Pro): toggle off → in-chat 'turn on' card; an unsaved home is never searched on the map, it's set by the user", { skip }, async () => {
  await withUser("PRO", async (say, userId) => {
    // No Home saved, toggle off: ask to turn on, then set Home (no map search for "home").
    let r = await say("We have to do 5 push ups today at home", false);
    assert.match(r.message.content, /reminder about this task when you get to Home\? Turn on Location reminders below/);
    assert.doesNotMatch(r.message.content, /several locations|couldn't find/);
    let task = await prisma.task.findFirstOrThrow({ where: { userId }, orderBy: { createdAt: "desc" } });
    assert.deepEqual(setupCard(r), { type: "location_setup", taskId: task.id, place: "Home", saved: false, remindersOn: false });
    assert.deepEqual(await linkedPlaces(userId), []);

    // Toggle on, Home still not saved: "Where is Home?" + the card goes straight to the map step.
    r = await say("Add a task to clean my room at ghar tomorrow at 5 PM", true);
    assert.match(r.message.content, /Where is Ghar\? Set it on the map below/);
    assert.equal(setupCard(r)?.type === "location_setup" && setupCard(r)?.remindersOn, true);

    // Home saved, toggle off: attached now, card only offers the toggle.
    await createOrFindLocation(userId, { name: "Home", latitude: 31.52, longitude: 74.35 });
    r = await say("Add a task to water the plants at home tomorrow at 6 PM", false);
    task = await prisma.task.findFirstOrThrow({ where: { userId }, orderBy: { createdAt: "desc" } });
    assert.deepEqual(setupCard(r), { type: "location_setup", taskId: task.id, place: "Home", saved: true, remindersOn: false });
    assert.ok((await linkedPlaces(userId)).includes("Home"));

    // Home saved, toggle on (or unknown, e.g. WhatsApp): plain "Location set", no card.
    r = await say("Add a task to fold laundry at home tomorrow at 7 PM", true);
    assert.match(r.message.content, /Location set: Home/);
    assert.equal(setupCard(r), undefined);
  });
});

test("an old 'which location?' question never swallows a new task that mentions the place", { skip }, async () => {
  await withUser("PRO", async (say, userId) => {
    await say("hello");
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { userId } });
    const old = await prisma.task.create({ data: { userId, title: "Go to wahsorm", priority: "MEDIUM", source: "CHAT" } });
    const results = [
      { name: "home", displayName: "home, Al-Hussain Road, Johar Town, Lahore", latitude: 31.46, longitude: 74.27 },
      { name: "home", displayName: "home, Walton Road, Model Town, Lahore", latitude: 31.49, longitude: 74.33 },
    ];
    const plant = () => prisma.conversation.update({ where: { id: conversation.id }, data: { state: { pending: { kind: "location_choice", taskId: old.id, taskTitle: old.title, place: "home", results, more: false }, focus: [], prereqAsked: [], turn: 1 } } });

    await plant();
    const r = await say("Add a task to go to washroom at home today", true);
    assert.equal(r.message.intent, "task_created", r.message.content);
    assert.match(r.message.content, /Go to washroom/);
    assert.doesNotMatch(r.message.content, /Al-Hussain/);
    assert.deepEqual(await linkedPlaces(userId), [], "nothing pinned from the old list");

    await plant();
    const pick = await say("Walton Road", true);
    assert.equal(pick.message.intent, "location_set");
    assert.match(pick.message.content, /Walton Road/);
  });
});

test("location by chat: not found → set-on-map card; 'its location' is the task just added; 'the 2nd task' is from the last list", { skip }, async () => {
  await withUser("PRO", async (say, userId) => {
    const gulberg = [{ name: "KFC", display_name: "KFC, Main Boulevard, Gulberg, Lahore, Pakistan", lat: "31.52", lon: "74.35" }];
    await say("Add a task to call the bank today at 9 PM", true);
    let r!: Awaited<ReturnType<typeof say>>;
    await withNominatim([], async () => {
      r = await say("I want to eat burger from KFC kalma chowk today", true);
    });
    const kfc = await prisma.task.findFirstOrThrow({ where: { userId, title: { contains: "burger" } } });
    assert.match(r.message.content, /couldn't find 'KFC kalma chowk' on the map\. Set it below/);
    assert.deepEqual(setupCard(r), { type: "location_setup", taskId: kfc.id, place: "KFC kalma chowk", saved: false, remindersOn: true });

    await withNominatim(gulberg, async () => {
      r = await say("change its location to KFC Gulberg", true);
    });
    assert.equal(r.message.intent, "location_changed", r.message.content);
    assert.match(r.message.content, /Location set: KFC, Main Boulevard, Gulberg/);
    assert.deepEqual(await linkedPlaces(userId), ["KFC Gulberg"]);

    const list = await say("Show my tasks for today", true);
    const shown = list.message.cards?.find((c) => c.type === "task_list");
    const pos = shown?.type === "task_list" ? shown.tasks.findIndex((t) => t.id === kfc.id) : -1;
    assert.ok(pos >= 0, "KFC task is in the list");
    const nth = ["1st", "2nd", "3rd", "4th", "5th"][pos];
    await withNominatim([{ name: "Kalma Chowk", display_name: "Kalma Chowk, Gulberg III, Lahore, Pakistan", lat: "31.50", lon: "74.33" }], async () => {
      r = await say(`${nth} task from today, change its location to kalma chowk gulberg`, true);
    });
    assert.equal(r.message.intent, "location_changed", r.message.content);
    assert.match(r.message.content, /Kalma Chowk, Gulberg III/);
    const links = await prisma.taskLocation.findMany({ where: { taskId: kfc.id }, include: { savedLocation: true } });
    assert.deepEqual(links.map((l) => l.savedLocation.name), ["Kalma chowk gulberg"]);
  });
});
