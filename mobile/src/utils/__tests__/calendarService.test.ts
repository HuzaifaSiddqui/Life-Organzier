import { beforeEach, describe, expect, it, vi } from "vitest";

// services/calendar with everything native mocked: storage in a Map, the API answer chosen per test, expo-calendar spied.
const store = new Map<string, string>();
const server = { enabled: false };
const log: string[] = [];
const apiGet = vi.fn(async () => (server.enabled ? { enabled: true, windowStart: "2026-11-03T19:00:00.000Z", windowEnd: "2026-11-17T19:00:00.000Z", occurrences: [] } : { enabled: false }));

type FakeCalendar = { id: string; title: string; allowsModifications: boolean; events: Map<string, { title: string }>; createEvent: ReturnType<typeof vi.fn>; listEvents: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
let calendars: FakeCalendar[] = [];
const allEvents = new Map<string, { title: string; cal: FakeCalendar }>();
let n = 0;

function fakeCalendar(id: string, title = "Life Organizer", existing: string[] = []): FakeCalendar {
  const cal: FakeCalendar = {
    id,
    title,
    allowsModifications: true,
    events: new Map(),
    createEvent: vi.fn(async (d: { title: string }) => {
      const eid = `ev${++n}`;
      log.push(`create ${d.title}`);
      cal.events.set(eid, d);
      allEvents.set(eid, { title: d.title, cal });
      return { id: eid };
    }),
    listEvents: vi.fn(async () => [...cal.events.keys()].map((eid) => eventObject(eid))),
    delete: vi.fn(async () => {
      log.push(`delete calendar ${id}`);
      calendars = calendars.filter((c) => c !== cal);
    }),
  };
  for (const title of existing) {
    const eid = `old${++n}`;
    cal.events.set(eid, { title });
    allEvents.set(eid, { title, cal });
  }
  return cal;
}

function eventObject(eid: string) {
  return {
    update: async () => undefined,
    delete: async () => {
      const e = allEvents.get(eid);
      if (!e) throw new Error("gone");
      log.push(`delete ${e.title}`);
      e.cal.events.delete(eid);
      allEvents.delete(eid);
    },
  };
}

const calendarApi = {
  requestCalendarPermissions: vi.fn(async () => ({ granted: true })),
  getCalendarPermissions: vi.fn(async () => ({ granted: true })),
  getCalendars: vi.fn(async () => calendars),
  createCalendar: vi.fn(async () => {
    const cal = fakeCalendar("new1");
    calendars.push(cal);
    return cal;
  }),
  listEvents: vi.fn(async () => []),
  getDefaultCalendarSync: vi.fn(),
  ExpoCalendarEvent: { get: vi.fn(async (eid: string) => eventObject(eid)) },
  EntityTypes: { EVENT: "event" },
  CalendarAccessLevel: { OWNER: "owner" },
  Availability: { FREE: "free" },
};

vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async (k: string) => store.get(k) ?? null, setItem: async (k: string, v: string) => void store.set(k, v) },
}));
vi.mock("../../lib/firebase", () => ({ auth: { currentUser: { uid: "u1" } } }));
vi.mock("../../services/api", () => ({ apiGet }));
vi.mock("../../services/syncEngine", () => ({
  readTasks: async () => [{ id: "t1", title: "Physics report", status: "PENDING", dueDate: "2026-11-06T00:00:00.000Z", dueTime: "3 PM", dueAt: "2026-11-06T10:00:00.000Z" }],
}));
vi.mock("expo-calendar", () => calendarApi);

const KEY = "life-organizer:calendar:v1:u1";
const setState = (s: object) => store.set(KEY, JSON.stringify(s));
const state = () => JSON.parse(store.get(KEY) ?? "{}");
const load = async () => {
  vi.resetModules();
  return import("../../services/calendar");
};

beforeEach(() => {
  store.clear();
  log.length = 0;
  allEvents.clear();
  calendars = [];
  vi.clearAllMocks();
});

describe("calendar service: flag off changes nothing", () => {
  it("switch never turned on: a sync reads only local storage, no server call, no calendar call", async () => {
    server.enabled = true;
    const cal = await load();
    await cal.syncCalendar();
    expect(apiGet).not.toHaveBeenCalled();
    expect(calendarApi.getCalendars).not.toHaveBeenCalled();
    expect(await cal.clashesForTask({ dueDate: "2026-11-06T00:00:00.000Z", dueTime: "3 PM", dueAt: "2026-11-06T10:00:00.000Z", scheduledStart: null, scheduledEnd: null, durationMinutes: null })).toEqual([]);
    expect(calendarApi.listEvents).not.toHaveBeenCalled();
  });

  it("switch on but the server flag is off: nothing is written or read", async () => {
    calendars = [fakeCalendar("cal1")];
    setState({ on: true, calendarId: "cal1", owned: true, map: {} });
    server.enabled = false;
    const cal = await load();
    await cal.syncCalendar();
    expect(calendars[0].createEvent).not.toHaveBeenCalled();
    expect(await cal.agendaFor("2026-11-06")).toBeNull();
    expect(calendarApi.listEvents).not.toHaveBeenCalled();
  });

  it("flag on and switch on: the task is written once to our calendar", async () => {
    calendars = [fakeCalendar("cal1")];
    setState({ on: true, calendarId: "cal1", owned: true, map: {} });
    server.enabled = true;
    const cal = await load();
    await cal.syncCalendar();
    await cal.syncCalendar();
    expect(log).toEqual(["create Physics report"]);
    expect(await cal.ourEventCount()).toBe(1);
  });

  it("permission denied: the switch stays off and the app carries on", async () => {
    server.enabled = true;
    calendarApi.requestCalendarPermissions.mockResolvedValueOnce({ granted: false });
    const cal = await load();
    expect(await cal.enableCalendarSync()).toBe("denied");
    expect(await cal.calendarSyncActive()).toBe(false);
  });
});

describe("calendar service: adopting and removing", () => {
  it("empty map + a 'Life Organizer' calendar found by title: its events are deleted first, then rebuilt, no duplicates", async () => {
    server.enabled = true;
    const old = fakeCalendar("cal2", "Life Organizer", ["Physics report", "Gym"]); // e.g. left by an earlier install
    calendars = [fakeCalendar("work", "Work", ["Standup"]), old];
    const cal = await load();
    expect(await cal.enableCalendarSync()).toBe("on");
    expect(log).toEqual(["delete Physics report", "delete Gym", "create Physics report"]);
    expect([...old.events.values()].map((e) => e.title)).toEqual(["Physics report"]);
    expect(calendars[0].events.size).toBe(1); // the Work calendar is untouched
    expect(state()).toMatchObject({ on: true, calendarId: "cal2", owned: false });
    expect(calendarApi.createCalendar).not.toHaveBeenCalled();
  });

  it("Remove all deletes only the stored calendar we created; another 'Life Organizer' calendar is left alone", async () => {
    server.enabled = true;
    const lookalike = fakeCalendar("user-made", "Life Organizer", ["Mum's birthday"]);
    calendars = [lookalike];
    setState({ on: true, calendarId: "gone", owned: true, map: {} });
    const cal = await load();
    // Stored id gone → the title match is adopted (events cleared, rebuilt) but it is not ours to delete.
    await cal.syncCalendar();
    log.length = 0;
    expect(await cal.removeAllCalendarEvents()).toBe(true);
    expect(lookalike.delete).not.toHaveBeenCalled();
    expect(log).toEqual(["delete Physics report"]);
    expect(calendars).toEqual([lookalike]);

    // A calendar this app created is deleted whole, and nothing else.
    const mine = fakeCalendar("mine");
    calendars = [lookalike, mine];
    setState({ on: true, calendarId: "mine", owned: true, map: {} });
    expect(await cal.removeAllCalendarEvents()).toBe(true);
    expect(mine.delete).toHaveBeenCalledTimes(1);
    expect(lookalike.delete).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ on: false, calendarId: null, map: {} });
  });

  it("Remove all with the stored calendar gone touches nothing (no title fallback)", async () => {
    const lookalike = fakeCalendar("user-made", "Life Organizer", ["Mum's birthday"]);
    calendars = [lookalike];
    setState({ on: true, calendarId: "gone", owned: true, map: { "t:t1": { eventId: "x", hash: "h", start: "2026-11-06T10:00:00.000Z" } } });
    const cal = await load();
    expect(await cal.removeAllCalendarEvents()).toBe(true);
    expect(lookalike.delete).not.toHaveBeenCalled();
    expect(lookalike.events.size).toBe(1);
  });
});
