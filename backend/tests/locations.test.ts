import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Priority, TaskSource, TaskStatus } from "@prisma/client";
import { prisma } from "../src/config/db.js";
import { geocode, resetGeocodeCache, reverseGeocode, type GeocodeDeps } from "../src/modules/locations/geocode.js";
import { attachLocation, createOrFindLocation, deleteLocation, detachLocation, locationInput, locationsForTasks, requirePro, resolveRadius, updateLocation } from "../src/modules/locations/locationService.js";
import { createTask, restoreTask, softDeleteTask, updateTask } from "../src/modules/tasks/taskService.js";
import { dbAvailable, settings } from "./fixtures.js";

const skip = !dbAvailable && "no database";

/* ------------------------------------------------------------------ pure rules */

test("locations: radius defaults to Nearby 350 m; presets and explicit radius", () => {
  assert.deepEqual(resolveRadius({}), { radiusM: 350, preset: "NEARBY" });
  assert.deepEqual(resolveRadius({ preset: "PRECISE" }), { radiusM: 200, preset: "PRECISE" });
  assert.deepEqual(resolveRadius({ preset: "AREA" }), { radiusM: 750, preset: "AREA" });
  assert.deepEqual(resolveRadius({ radiusM: 500 }), { radiusM: 500, preset: "NEARBY" });
});

test("locations: validation bounds for coordinates, radius, preset and name", () => {
  const ok = { name: "Home", latitude: 31.5, longitude: 74.3 };
  assert.ok(locationInput.safeParse(ok).success);
  for (const bad of [{ latitude: 91 }, { longitude: -181 }, { radiusM: 99 }, { radiusM: 2001 }, { preset: "HUGE" }, { name: " " }, { name: "x".repeat(101) }]) {
    assert.equal(locationInput.safeParse({ ...ok, ...bad }).success, false, JSON.stringify(bad));
  }
});

test("locations: create/attach need Pro", () => {
  assert.throws(() => requirePro(settings({ tier: "FREE" })), /Pro/);
  assert.doesNotThrow(() => requirePro(settings({ tier: "PRO" })));
});

/* ------------------------------------------------------------------ geocoding */

function fakeNominatim(body: unknown, opts: { ok?: boolean } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let clock = 0;
  const deps: GeocodeDeps = {
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers });
      return { ok: opts.ok ?? true, status: opts.ok === false ? 503 : 200, json: async () => body };
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  return { calls, deps, advance: (ms: number) => (clock += ms), sleeps: () => clock };
}

const place = (name: string, i: number) => ({ name, display_name: `${name}, Lahore, Pakistan`, lat: String(31.5 + i / 100), lon: String(74.3 + i / 100) });

test("geocode: User-Agent, max 5 results, bias box around the user", async () => {
  resetGeocodeCache();
  const f = fakeNominatim(Array.from({ length: 7 }, (_, i) => place(`Store ${i}`, i)));
  const r = await geocode("medical store", { lat: 31.5, lng: 74.3 }, f.deps);
  assert.equal(r.length, 5);
  assert.deepEqual(r[0], { name: "Store 0", displayName: "Store 0, Lahore, Pakistan", latitude: 31.5, longitude: 74.3 });
  assert.equal(f.calls[0].headers["User-Agent"], "LifeOrganizer/1.0 (FYP)");
  assert.match(f.calls[0].url, /viewbox=74\.05%2C31\.75%2C74\.55%2C31\.25/);
});

test("geocode: cached for 24 h; calls are at least 1 s apart", async () => {
  resetGeocodeCache();
  const f = fakeNominatim([place("COMSATS", 0)]);
  await geocode("comsats", null, f.deps);
  await geocode("comsats", null, f.deps);
  assert.equal(f.calls.length, 1, "second lookup served from cache");
  await geocode("anarkali", null, f.deps); // different query right away → waits for the 1 s gap
  assert.equal(f.calls.length, 2);
  assert.ok(f.sleeps() >= 1000);
  f.advance(24 * 3600 * 1000);
  await geocode("comsats", null, f.deps);
  assert.equal(f.calls.length, 3, "expired after 24 h");
});

test("geocode: errors and odd rows give an empty list, never throw", async () => {
  resetGeocodeCache();
  assert.deepEqual(await geocode("x place", null, fakeNominatim([], { ok: false }).deps), []);
  resetGeocodeCache();
  assert.deepEqual(await geocode("y place", null, fakeNominatim([{ display_name: "No coords" }]).deps), []);
  resetGeocodeCache();
  assert.equal(await reverseGeocode(31.5, 74.3, fakeNominatim({ error: "Unable to geocode" }).deps), null);
});

test("reverse geocode keeps the user's exact coordinates and names the place", async () => {
  resetGeocodeCache();
  const r = await reverseGeocode(31.52049, 74.35871, fakeNominatim(place("Liberty Market", 0)).deps);
  assert.deepEqual(r, { name: "Liberty Market", displayName: "Liberty Market, Lahore, Pakistan", latitude: 31.52049, longitude: 74.35871 });
});

/* ------------------------------------------------------------------ database */

async function withUser(fn: (userId: string) => Promise<void>) {
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, tier: "PRO" } });
  try {
    await fn(user.id);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
}

const newTask = (userId: string, title: string) => createTask({ userId, tz: "Asia/Karachi" }, { title, priority: Priority.MEDIUM, source: TaskSource.MANUAL });

test("locations: same name (any case) returns the existing place", { skip }, async () => {
  await withUser(async (userId) => {
    const a = await createOrFindLocation(userId, { name: "Ali Medical Store", latitude: 31.5, longitude: 74.3 });
    const b = await createOrFindLocation(userId, { name: "ali medical store", latitude: 1, longitude: 1, preset: "AREA" });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(b.location.id, a.location.id);
    assert.equal(b.location.radiusM, 350);
  });
});

test("locations: attach counts usage once; many tasks share one place; detach", { skip }, async () => {
  await withUser(async (userId) => {
    const { location } = await createOrFindLocation(userId, { name: "Anarkali", latitude: 31.57, longitude: 74.31, preset: "AREA" });
    const t1 = await newTask(userId, "Buy cloth");
    const t2 = await newTask(userId, "Get shoes fixed");
    await attachLocation(userId, t1.id, location.id);
    await attachLocation(userId, t1.id, location.id); // duplicate attach: no-op
    await attachLocation(userId, t2.id, location.id);
    assert.equal((await prisma.savedLocation.findUniqueOrThrow({ where: { id: location.id } })).usageCount, 2);
    const map = await locationsForTasks([t1, t2]);
    assert.equal(map.get(t1.id)?.length, 1);
    assert.deepEqual(
      { name: map.get(t2.id)![0].name, radiusM: map.get(t2.id)![0].radiusM, preset: map.get(t2.id)![0].preset, active: map.get(t2.id)![0].active },
      { name: "Anarkali", radiusM: 750, preset: "AREA", active: true },
    );
    await detachLocation(userId, t1.id, map.get(t1.id)![0].id);
    assert.equal((await locationsForTasks([t1])).get(t1.id), undefined);
    await assert.rejects(detachLocation(userId, t1.id, randomUUID()), /isn't attached/);
  });
});

test("locations: completing or deleting a task deactivates its geofence; reopening or restoring reactivates", { skip }, async () => {
  await withUser(async (userId) => {
    const ctx = { userId, tz: "Asia/Karachi" };
    const { location } = await createOrFindLocation(userId, { name: "Pharmacy", latitude: 31.5, longitude: 74.3 });
    const t = await newTask(userId, "Buy medicine");
    await attachLocation(userId, t.id, location.id);
    const active = async () => (await prisma.taskLocation.findFirstOrThrow({ where: { taskId: t.id } })).active;
    await updateTask(ctx, t.id, { status: TaskStatus.COMPLETED });
    assert.equal(await active(), false);
    await updateTask(ctx, t.id, { status: TaskStatus.PENDING });
    assert.equal(await active(), true);
    await softDeleteTask(ctx, t.id);
    assert.equal(await active(), false);
    await restoreTask(ctx, t.id);
    assert.equal(await active(), true);
  });
});

test("locations: a parent completed through its sub-tasks deactivates its geofence", { skip }, async () => {
  await withUser(async (userId) => {
    const ctx = { userId, tz: "Asia/Karachi" };
    const { location } = await createOrFindLocation(userId, { name: "Market", latitude: 31.5, longitude: 74.3 });
    const parent = await newTask(userId, "Shopping");
    const child = await createTask(ctx, { title: "Buy rice", priority: Priority.MEDIUM, source: TaskSource.MANUAL, parentTaskId: parent.id });
    await attachLocation(userId, parent.id, location.id);
    await updateTask(ctx, child.id, { status: TaskStatus.COMPLETED });
    assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: parent.id } })).status, TaskStatus.COMPLETED);
    assert.equal((await prisma.taskLocation.findFirstOrThrow({ where: { taskId: parent.id } })).active, false);
  });
});

test("locations: users can't touch each other's places; deleting a place removes its attachments; changes re-sync tasks", { skip }, async () => {
  await withUser(async (userId) => {
    await withUser(async (otherId) => {
      const { location } = await createOrFindLocation(userId, { name: "Home", latitude: 31.5, longitude: 74.3 });
      const t = await newTask(userId, "Water plants");
      const other = await newTask(otherId, "Not mine");
      await assert.rejects(attachLocation(otherId, other.id, location.id), /Place not found/);
      await assert.rejects(attachLocation(otherId, t.id, location.id), /Task not found/);
      await assert.rejects(updateLocation(otherId, location.id, { name: "Mine now" }), /Place not found/);
      await attachLocation(userId, t.id, location.id);
      const before = (await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).updatedAt;
      await new Promise((r) => setTimeout(r, 5));
      const moved = await updateLocation(userId, location.id, { preset: "PRECISE" });
      assert.equal(moved.radiusM, 200);
      assert.ok((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).updatedAt > before, "task re-sent by the next sync pull");
      await deleteLocation(userId, location.id);
      assert.equal(await prisma.taskLocation.count({ where: { taskId: t.id } }), 0);
    });
  });
});
