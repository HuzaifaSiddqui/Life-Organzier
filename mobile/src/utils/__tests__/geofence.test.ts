import { describe, expect, it } from "vitest";
import type { Task, TaskLocation } from "../../types/models";
import { buildNotificationBody, DEDUP_MS, distanceM, groupTasksByLocation, isDedupActive, locatedTaskIds, placesToAnnounceNow, promptedInChat, selectTopLocations, shouldAskForLocation, tasksToAnnounce, type GeofencePlace, type GeofenceTask } from "../geofence";

const NOW = Date.parse("2026-10-13T10:00:00Z");

const loc = (savedLocationId: string, o: Partial<TaskLocation> = {}): TaskLocation => ({
  id: `tl-${savedLocationId}-${Math.random()}`,
  savedLocationId,
  name: savedLocationId,
  latitude: 31.5,
  longitude: 74.3,
  radiusM: 350,
  preset: "NEARBY",
  usageCount: 1,
  active: true,
  lastTriggeredAt: null,
  ...o,
});

const task = (id: string, locations: TaskLocation[], o: Partial<Task> = {}) => ({ id, title: `Task ${id}`, status: "PENDING", scheduledStart: null, locations, ...o }) as Task;

const gt = (n: number, o: Partial<GeofenceTask> = {}): GeofenceTask => ({ taskId: `t${n}`, taskLocationId: `tl${n}`, title: `Task ${n}`, status: "PENDING", scheduledStart: null, ...o });
const place = (id: string, usageCount: number): GeofencePlace => ({ id, name: id, latitude: 0, longitude: 0, radiusM: 350, usageCount, tasks: [gt(1)] });
const clock = () => "4:00 PM";

describe("groupTasksByLocation", () => {
  it("makes one place per saved location, even when several tasks point to it", () => {
    const places = groupTasksByLocation([task("a", [loc("market")]), task("b", [loc("market"), loc("home")]), task("c", [loc("home")])]);
    expect(places.map((p) => [p.id, p.tasks.map((t) => t.taskId)])).toEqual([
      ["market", ["a", "b"]],
      ["home", ["b", "c"]],
    ]);
  });

  it("skips finished tasks and inactive links", () => {
    const places = groupTasksByLocation([
      task("done", [loc("market")], { status: "COMPLETED" }),
      task("off", [loc("market", { active: false })]),
      task("busy", [loc("market")], { status: "IN_PROGRESS" }),
      task("none", []),
    ]);
    expect(places).toHaveLength(1);
    expect(places[0].tasks.map((t) => t.taskId)).toEqual(["busy"]);
  });
});

describe("selectTopLocations", () => {
  it("keeps at most 20, most used first, and counts the rest", () => {
    const many = Array.from({ length: 25 }, (_, i) => place(`p${String(i).padStart(2, "0")}`, i));
    const { places, dropped } = selectTopLocations(many);
    expect(places).toHaveLength(20);
    expect(dropped).toBe(5);
    expect(places[0].usageCount).toBe(24);
    expect(places.map((p) => p.usageCount)).not.toContain(4);
  });

  it("keeps everything under the limit; ties sort by name", () => {
    const { places, dropped } = selectTopLocations([place("b", 1), place("a", 1), place("c", 3)]);
    expect(places.map((p) => p.id)).toEqual(["c", "a", "b"]);
    expect(dropped).toBe(0);
  });
});

describe("isDedupActive", () => {
  it("is active within 4 h, expired after, and off when missing", () => {
    expect(isDedupActive(NOW - 60000, NOW)).toBe(true);
    expect(isDedupActive(NOW - DEDUP_MS + 1, NOW)).toBe(true);
    expect(isDedupActive(NOW - DEDUP_MS, NOW)).toBe(false);
    expect(isDedupActive(undefined, NOW)).toBe(false);
    expect(isDedupActive(null, NOW)).toBe(false);
    expect(isDedupActive(0, NOW)).toBe(false);
  });

  it("tasksToAnnounce drops recently announced and finished tasks", () => {
    const p: GeofencePlace = { ...place("market", 1), tasks: [gt(1), gt(2), gt(3, { status: "COMPLETED" })] };
    expect(tasksToAnnounce(p, { tl1: NOW - 60000 }, NOW).map((t) => t.taskId)).toEqual(["t2"]);
  });
});

describe("buildNotificationBody", () => {
  const future = new Date(NOW + 3600000).toISOString();
  const past = new Date(NOW - 3600000).toISOString();

  it("English: single, early, few, many, none", () => {
    expect(buildNotificationBody("Ali Medical Store", [gt(1, { title: "Buy medicine" })], NOW, "en", clock)).toBe("You're nearby Ali Medical Store — Buy medicine");
    expect(buildNotificationBody("Ali Medical Store", [gt(1, { title: "Buy medicine", scheduledStart: past })], NOW, "en", clock)).toBe("You're nearby Ali Medical Store — Buy medicine");
    expect(buildNotificationBody("Market", [gt(1, { title: "Buy rice", scheduledStart: future })], NOW, "en", clock)).toBe("You're near Market early. Buy rice is planned for 4:00 PM. Start now?");
    expect(buildNotificationBody("Market", [gt(1), gt(2), gt(3)], NOW, "en", clock)).toBe("You're near Market: Task 1, Task 2, Task 3");
    expect(buildNotificationBody("Market", [gt(1), gt(2), gt(3), gt(4)], NOW, "en", clock)).toBe("You're near Market: 4 tasks waiting");
    expect(buildNotificationBody("Market", [], NOW, "en", clock)).toBeNull();
  });

  it("Urdu: all four wordings", () => {
    expect(buildNotificationBody("بازار", [gt(1, { title: "چاول" })], NOW, "ur", clock)).toBe("آپ بازار کے قریب ہیں — چاول");
    expect(buildNotificationBody("بازار", [gt(1, { title: "چاول", scheduledStart: future })], NOW, "ur", clock)).toBe("آپ بازار کے قریب جلدی پہنچ گئے۔ چاول 4:00 PM کے لیے طے ہے۔ ابھی شروع کریں؟");
    expect(buildNotificationBody("بازار", [gt(1), gt(2)], NOW, "ur", clock)).toBe("آپ بازار کے قریب ہیں: Task 1، Task 2");
    expect(buildNotificationBody("بازار", [gt(1), gt(2), gt(3), gt(4), gt(5)], NOW, "ur", clock)).toBe("آپ بازار کے قریب ہیں: 5 کام باقی ہیں");
  });
});

describe("distanceM", () => {
  it("is about 1.1 km for 0.01° of latitude and 0 for the same point", () => {
    expect(Math.round(distanceM({ latitude: 31.5, longitude: 74.3 }, { latitude: 31.51, longitude: 74.3 }))).toBe(1112);
    expect(distanceM({ latitude: 31.5, longitude: 74.3 }, { latitude: 31.5, longitude: 74.3 })).toBe(0);
  });
});

describe("asking for location access", () => {
  it("asks at the first check of a launch and for each new task with a place, only while reminders can't fire", () => {
    expect(shouldAskForLocation(null, ["a"], false)).toBe(true); // relaunch with a located task
    expect(shouldAskForLocation(new Set(["a"]), ["a"], false)).toBe(false); // nothing new: no nag
    expect(shouldAskForLocation(new Set(["a"]), ["a", "b"], false)).toBe(true); // "add a task … at home"
    expect(shouldAskForLocation(null, ["a"], true)).toBe(false); // already allowed and on
    expect(shouldAskForLocation(null, [], false)).toBe(false); // no task uses a place
  });

  it("chat and voice tasks are prompted by the in-chat card, others by the snackbar", () => {
    expect(promptedInChat(task("a", [], { source: "CHAT" }))).toBe(true);
    expect(promptedInChat(task("b", [], { source: "VOICE" }))).toBe(true);
    expect(promptedInChat(task("c", [], { source: "MANUAL" }))).toBe(false);
  });

  it("watched tasks: open, with an active place, each once", () => {
    const ids = locatedTaskIds([task("a", [loc("home"), loc("uni")]), task("done", [loc("home")], { status: "COMPLETED" }), task("none", [])]);
    expect(ids).toEqual(["a"]);
  });
});

describe("placesToAnnounceNow", () => {
  const home: GeofencePlace = { id: "home", name: "Home", latitude: 31.5, longitude: 74.3, radiusM: 150, usageCount: 1, tasks: [gt(1), gt(2)] };
  const uni: GeofencePlace = { id: "uni", name: "Uni", latitude: 31.6, longitude: 74.4, radiusM: 350, usageCount: 1, tasks: [gt(3)] };
  it("announces a place at once when a task was just added to it and the user is inside", () => {
    expect(placesToAnnounceNow([home, uni], ["t2"], { latitude: 31.5003, longitude: 74.3 })).toEqual(["home"]); // ~33 m away
  });
  it("not when outside the radius, not for places without a new task, not without a position", () => {
    expect(placesToAnnounceNow([home], ["t2"], { latitude: 31.51, longitude: 74.3 })).toEqual([]); // ~1.1 km
    expect(placesToAnnounceNow([home, uni], ["t3"], { latitude: 31.5, longitude: 74.3 })).toEqual([]);
    expect(placesToAnnounceNow([home], ["t1"], null)).toEqual([]);
    expect(placesToAnnounceNow([home], [], { latitude: 31.5, longitude: 74.3 })).toEqual([]);
  });
});
