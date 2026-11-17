import { beforeEach, describe, expect, it, vi } from "vitest";

// services/calendar (one-way) with everything native mocked: storage in a Map, the server flag per test, expo-calendar faked.
const store = new Map<string, string>();
const server = { enabled: false };
const apiGet = vi.fn(async () => ({ enabled: server.enabled }));
const createTask = vi.fn(async (input: { title: string }) => ({ id: `task-${input.title}`, ...input }));
const log: string[] = [];
const MARK = "Created by Life Organizer";

type FakeEvent = { id: string; title: string; notes?: string; startDate: string; endDate: string; allDay?: boolean };
type FakeCalendar = { id: string; title: string; events: Map<string, FakeEvent>; listEvents: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
let calendars: FakeCalendar[] = [];
let n = 0;

const inAnHour = () => new Date(Date.now() + 3600000).toISOString();
const inTwoHours = () => new Date(Date.now() + 7200000).toISOString();

/** `existing`: "mine:<title>" carries the old two-way marker; plain titles are the user's own events (in an hour). */
function fakeCalendar(id: string, title: string, existing: string[] = []): FakeCalendar {
  const cal: FakeCalendar = {
    id,
    title,
    events: new Map(),
    listEvents: vi.fn(async () => [...cal.events.values()].map(eventObject)),
    delete: vi.fn(async () => {
      log.push(`delete calendar ${id}`);
      calendars = calendars.filter((c) => c !== cal);
    }),
  };
  for (const raw of existing) {
    const eid = `ev${++n}`;
    const mine = raw.startsWith("mine:");
    cal.events.set(eid, { id: eid, title: mine ? raw.slice(5) : raw, notes: mine ? MARK : "", startDate: inAnHour(), endDate: inTwoHours() });
  }
  return cal;
}

function eventObject(e: FakeEvent) {
  return {
    ...e,
    delete: async () => {
      const cal = calendars.find((c) => c.events.has(e.id));
      if (!cal) throw new Error("gone");
      log.push(`delete ${e.title}`);
      cal.events.delete(e.id);
    },
  };
}

const calendarApi = {
  requestCalendarPermissions: vi.fn(async () => ({ granted: true })),
  getCalendarPermissions: vi.fn(async () => ({ granted: true })),
  getCalendars: vi.fn(async () => calendars),
  listEvents: vi.fn(async (cals: FakeCalendar[]) => cals.flatMap((c) => [...c.events.values()].map(eventObject))),
  createCalendar: vi.fn(),
  ExpoCalendarEvent: {
    get: vi.fn(async (eid: string) => {
      const e = calendars.flatMap((c) => [...c.events.values()]).find((x) => x.id === eid);
      if (!e) throw new Error("gone");
      return eventObject(e);
    }),
  },
  EntityTypes: { EVENT: "event" },
  Availability: { FREE: "free" },
};

vi.mock("react-native", () => ({ Platform: { OS: "ios" }, AppState: { addEventListener: () => ({ remove() {} }), currentState: "active" } }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
  },
}));
vi.mock("../../lib/firebase", () => ({ auth: { currentUser: { uid: "u1" } } }));
vi.mock("../../services/api", () => ({ apiGet }));
vi.mock("../../services/syncEngine", () => ({ readTasks: async () => [] }));
vi.mock("../../services/tasksApi", () => ({ createTask }));
vi.mock("expo-calendar", () => calendarApi);

const KEY = "life-organizer:calendar:v2:u1";
const LEGACY = "life-organizer:calendar:v1:u1";
const switchOn = () => store.set(KEY, JSON.stringify({ on: true, decided: {}, pending: [] }));
const load = async () => {
  vi.resetModules();
  return import("../../services/calendar");
};

beforeEach(() => {
  store.clear();
  log.length = 0;
  calendars = [];
  server.enabled = false;
  vi.clearAllMocks();
});

describe("calendar service (one-way): off changes nothing", () => {
  it("switch never turned on: a sync makes no server call and no calendar call", async () => {
    server.enabled = true;
    const cal = await load();
    await cal.syncCalendar();
    expect(apiGet).not.toHaveBeenCalled();
    expect(calendarApi.getCalendars).not.toHaveBeenCalled();
    expect(await cal.pendingImports()).toEqual([]);
  });

  it("switch on but the server flag is off: nothing is read", async () => {
    calendars = [fakeCalendar("work", "Work", ["Standup"])];
    switchOn();
    const cal = await load();
    await cal.syncCalendar();
    expect(calendarApi.listEvents).not.toHaveBeenCalled();
    expect(await cal.agendaFor("2026-11-06")).toBeNull();
  });

  it("permission denied: the switch stays off", async () => {
    server.enabled = true;
    calendarApi.requestCalendarPermissions.mockResolvedValueOnce({ granted: false });
    const cal = await load();
    expect(await cal.enableCalendarSync()).toBe("denied");
    expect(await cal.calendarSyncActive()).toBe(false);
  });
});

describe("calendar service (one-way): import", () => {
  it("turning it on offers the calendars' upcoming events; Add makes a task, Skip hides it; nothing is written to the calendar", async () => {
    server.enabled = true;
    calendars = [fakeCalendar("work", "Work", ["Standup", "Dentist"])];
    const cal = await load();
    const seen: number[] = [];
    cal.subscribeCalendarImports((p) => seen.push(p.length));
    expect(await cal.enableCalendarSync()).toBe("on");
    const pending = await cal.pendingImports();
    expect(pending.map((c) => c.title).sort()).toEqual(["Dentist", "Standup"]);
    expect(seen).toEqual([2]);

    const dentist = pending.find((c) => c.title === "Dentist")!;
    const standup = pending.find((c) => c.title === "Standup")!;
    expect(await cal.addImports([dentist.key], "From your calendar")).toBe(1);
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ title: "Dentist", description: "From your calendar", scheduledStart: dentist.start }));
    await cal.skipImports([standup.key]);
    expect(await cal.pendingImports()).toEqual([]);

    // The next sync offers neither again, and the calendar is untouched.
    await cal.syncCalendar();
    expect(await cal.pendingImports()).toEqual([]);
    expect(calendars[0].events.size).toBe(2);
    expect(log).toEqual([]);
  });

  it("turning it off drops what was waiting", async () => {
    server.enabled = true;
    calendars = [fakeCalendar("work", "Work", ["Standup"])];
    const cal = await load();
    await cal.enableCalendarSync();
    expect(await cal.pendingImports()).toHaveLength(1);
    await cal.disableCalendarSync();
    expect(await cal.pendingImports()).toEqual([]);
    expect(await cal.calendarSyncActive()).toBe(false);
  });
});

describe("calendar service (one-way): clean-up of the two-way version's events", () => {
  it("a calendar the app created is deleted once; the switch keeps its position", async () => {
    server.enabled = true;
    calendars = [fakeCalendar("work", "Work", ["Standup"]), fakeCalendar("ours", "Life Organizer", ["mine:Physics report"])];
    store.set(LEGACY, JSON.stringify({ on: true, calendarId: "ours", owned: true, map: {} }));
    const cal = await load();
    await cal.syncCalendar();
    expect(log).toEqual(["delete calendar ours"]);
    expect(store.has(LEGACY)).toBe(false);
    expect(await cal.calendarSyncActive()).toBe(true);
    expect((await cal.pendingImports()).map((c) => c.title)).toEqual(["Standup"]);
    await cal.syncCalendar();
    expect(log).toEqual(["delete calendar ours"]);
  });

  it("in the user's Google calendar only the app's marked events go; the user's events stay and are offered", async () => {
    server.enabled = true;
    const google = fakeCalendar("google", "me@example.test", ["Mum's birthday", "mine:Physics report", "mine:Gym"]);
    calendars = [google];
    const gymId = [...google.events.values()].find((e) => e.title === "Gym")!.id;
    store.set(LEGACY, JSON.stringify({ on: false, calendarId: "google", owned: false, map: { "t:t1": { eventId: gymId } } }));
    switchOn();
    const cal = await load();
    await cal.syncCalendar();
    expect(google.delete).not.toHaveBeenCalled();
    expect([...google.events.values()].map((e) => e.title)).toEqual(["Mum's birthday"]);
    expect(log.sort()).toEqual(["delete Gym", "delete Physics report"]);
    expect((await cal.pendingImports()).map((c) => c.title)).toEqual(["Mum's birthday"]);
  });

  it("switch off but old events left behind: they are cleaned up, nothing is offered", async () => {
    server.enabled = true;
    const ours = fakeCalendar("ours", "Life Organizer", ["mine:Physics report"]);
    calendars = [ours];
    store.set(LEGACY, JSON.stringify({ on: false, calendarId: "ours", owned: true, map: {} }));
    const cal = await load();
    await cal.syncCalendar();
    expect(log).toEqual(["delete calendar ours"]);
    expect(await cal.pendingImports()).toEqual([]);
  });
});
