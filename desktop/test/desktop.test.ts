import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { APP_ID, APP_NAME, relaunchCommand, windowsIdentity } from "../src/appIdentity";
import { APP_ORIGIN, isExternalAllowed, resolveAppFile } from "../src/appProtocol";
import { IPC } from "../src/bridge";
import { LATE_GRACE_MS, MAX_ITEMS, planTimers, sanitizeReminders } from "../src/reminderScheduler";

const NOW = Date.parse("2026-11-12T10:00:00Z");
const at = (min: number) => new Date(NOW + min * 60000).toISOString();
const item = (id: string, min: number) => ({ id, fireAt: at(min), title: "T", body: "B", taskId: "t", routineOccurrenceId: null, kind: "reminder" as const });

describe("reminder scheduler", () => {
  it("keeps only well-formed, unique reminders from the app", () => {
    const out = sanitizeReminders([
      item("a", 5),
      item("a", 6),
      { ...item("b", 5), fireAt: "not a date" },
      { id: "c" },
      null,
      { ...item("d", 5), kind: "checkin", checkinId: "k1", category: "START" },
    ]);
    assert.deepEqual(out.map((r) => r.id), ["a", "d"]);
    assert.equal(out[1].kind, "checkin");
    assert.equal(out[1].checkinId, "k1");
    assert.deepEqual(sanitizeReminders("nope"), []);
    assert.equal(sanitizeReminders(Array.from({ length: MAX_ITEMS + 50 }, (_, i) => item(`x${i}`, i + 1))).length, MAX_ITEMS);
  });

  it("fires due ones now, future ones later, drops long-missed ones; soonest first", () => {
    const plan = planTimers([item("later", 30), item("late", -5), item("old", -LATE_GRACE_MS / 60000 - 1), item("soon", 1)], NOW);
    assert.deepEqual(plan.map((p) => [p.item.id, p.delay]), [
      ["late", 0],
      ["soon", 60000],
      ["later", 1800000],
    ]);
  });

  it("leaves out items beyond the timer limit", () => {
    assert.equal(planTimers([item("far", 60 * 24 * 40)], NOW).length, 0);
  });
});

describe("app:// protocol", () => {
  const root = path.resolve("/srv/web");

  it("serves files inside the web build and index.html for app routes", () => {
    assert.equal(resolveAppFile(root, `${APP_ORIGIN}/`), path.join(root, "index.html"));
    assert.equal(resolveAppFile(root, `${APP_ORIGIN}/tasks/123`), path.join(root, "index.html"));
    assert.equal(resolveAppFile(root, `${APP_ORIGIN}/_expo/static/js/web/index-1.js`), path.join(root, "_expo", "static", "js", "web", "index-1.js"));
  });

  it("refuses paths that leave the web build and other hosts", () => {
    assert.equal(resolveAppFile(root, `${APP_ORIGIN}/..%2f..%2fwindows%2fwin.ini`), null);
    // The URL parser itself folds "/%2e%2e/" away, so this stays inside the build.
    assert.equal(resolveAppFile(root, `${APP_ORIGIN}/%2e%2e/secret.txt`), path.join(root, "secret.txt"));
    assert.equal(resolveAppFile(root, `${APP_ORIGIN}/a/%2e%2e%2f%2e%2e%2f%2e%2e%2fsecret.txt`), null);
    assert.equal(resolveAppFile(root, "app://elsewhere/index.html"), null);
    assert.equal(resolveAppFile(root, "not a url"), null);
  });

  it("opens only web, mail and phone links outside the app", () => {
    assert.equal(isExternalAllowed("https://wa.me/923001234567"), true);
    assert.equal(isExternalAllowed("mailto:a@b.com"), true);
    assert.equal(isExternalAllowed("tel:1122"), true);
    assert.equal(isExternalAllowed("file:///C:/Windows/system32/calc.exe"), false);
    assert.equal(isExternalAllowed("javascript:alert(1)"), false);
  });
});

describe("bridge", () => {
  it("the preload script uses the same IPC channels as the main process", () => {
    const preload = fs.readFileSync(path.join(__dirname, "..", "src", "preload.js"), "utf8");
    for (const channel of Object.values(IPC)) assert.ok(preload.includes(`"${channel}"`), `preload is missing ${channel}`);
  });
});

describe("Windows identity", () => {
  const base = { execPath: "C:/x/electron.exe", appPath: "D:/repo/desktop", appData: "C:/Users/u/AppData/Roaming" };

  it("the installed app uses its own exe; the installer makes the shortcut", () => {
    const id = windowsIdentity({ ...base, packaged: true, execPath: "C:/Apps/Life Organizer.exe" });
    assert.equal(id.appId, APP_ID);
    assert.equal(id.shortcut, null);
    assert.equal(id.icon, "C:/Apps/Life Organizer.exe");
    assert.equal(relaunchCommand(id), '"C:/Apps/Life Organizer.exe"');
  });

  it("a development run gets its own id and a Start Menu shortcut named Life Organizer that relaunches this app", () => {
    const id = windowsIdentity({ ...base, packaged: false });
    assert.notEqual(id.appId, APP_ID);
    assert.ok(id.shortcut?.endsWith(path.join(`${APP_NAME} (development)`, `${APP_NAME}.lnk`)));
    assert.ok(id.shortcut?.includes(path.join("Start Menu", "Programs")));
    assert.equal(id.icon, path.join(base.appPath, "build", "icon.ico"));
    assert.equal(relaunchCommand(id), `"${base.execPath}" "${base.appPath}"`);
  });
});
