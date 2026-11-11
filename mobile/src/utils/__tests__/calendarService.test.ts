import { beforeEach, describe, expect, it, vi } from "vitest";

// services/calendar with everything native mocked: storage in a Map, the API answer chosen per test, expo-calendar spied.
const store = new Map<string, string>();
const server = { enabled: false };
const log: string[] = [];
const apiGet = vi.fn(async () => (server.enabled ? { enabled: true, windowStart: "2026-11-03T19:00:00.000Z", windowEnd: "2026-11-17T19:00:00.000Z", occurrences: [] } : { enabled: false }));

type FakeEvent = { title: string; notes?: string };
type FakeCalendar = { id: string; title: string; allowsModifications: boolean; source?: { name: string; type: string; isLocalAccount?: boolean }; isPrimary?: boolean; ownerAccount?: string; events: Map<string, FakeEvent>; createEvent: ReturnType<typeof vi.fn>; listEvents: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
let calendars: FakeCalendar[] = [];
const allEvents = new Map<string, FakeEvent & { cal: FakeCalendar }>();
const MARK = "Created by Life Organizer";
let n = 0;

/** `existing`: events already in the calendar; "mine:<title>" carries our marker, plain titles are the user's own. */
function fakeCalendar(id: string, title = "Life Organizer", existing: string[] = [], extra: Partial<FakeCalendar> = {}): FakeCalendar {
  const cal: FakeCalendar = {
    id,
    title,
    allowsModifications: true,
    ...extra,
    events: new Map(),
    createEvent: vi.fn(async (d: FakeEvent) => {
      const eid = `ev${++n}`;
      log.push(`create ${d.title}`);
      cal.events.set(eid, d);
      allEvents.set(eid, { ...d, cal });
      return { id: eid };
    }),
    listEvents: vi.fn(async () => [...cal.events.keys()].map((eid) => eventObject(eid))),
    delete: vi.fn(async () => {
      log.push(`delete calendar ${id}`);
      calendars = calendars.filter((c) => c !== cal);
    }),
  };
  for (const raw of existing) {
    const eid = `old${++n}`;
    const e = raw.startsWith("mine:") ? { title: raw.slice(5), notes: MARK } : { title: raw };
    cal.events.set(eid, e);
    allEvents.set(eid, { ...e, cal });
  }
  return cal;
}

function eventObject(eid: string) {
  return {
    id: eid,
    notes: allEvents.get(eid)?.notes ?? "",
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
  createCalendar: vi.fn(async (d: { title: string }) => {
    const cal = fakeCalendar("new1", d.title);
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
const authState: { currentUser: { uid: string; email?: string } } = { currentUser: { uid: "u1" } };
vi.mock("../../lib/firebase", () => ({ auth: authState }));
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
  authState.currentUser = { uid: "u1" };
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
  it("every event we write carries the marker", async () => {
    calendars = [fakeCalendar("cal1")];
    setState({ on: true, calendarId: "cal1", owned: true, map: {} });
    server.enabled = true;
    const cal = await load();
    await cal.syncCalendar();
    expect([...calendars[0].events.values()]).toEqual([expect.objectContaining({ title: "Physics report", notes: MARK })]);
  });

  it("reinstall with only marked events: adopted, its events deleted (no date window) and rebuilt, no duplicates", async () => {
    server.enabled = true;
    const old = fakeCalendar("cal2", "Life Organizer", ["mine:Physics report", "mine:Gym"]);
    calendars = [fakeCalendar("work", "Work", ["Standup"]), old];
    const cal = await load();
    expect(await cal.enableCalendarSync()).toBe("on");
    expect(log).toEqual(["delete Physics report", "delete Gym", "create Physics report"]);
    expect([...old.events.values()].map((e) => e.title)).toEqual(["Physics report"]);
    expect(calendars[0].events.size).toBe(1); // the Work calendar is untouched
    expect(state()).toMatchObject({ on: true, calendarId: "cal2", owned: false });
    expect(calendarApi.createCalendar).not.toHaveBeenCalled();
    // The whole span is searched (1970–2100 in 3-year queries), not just a window around today.
    const ranges = old.listEvents.mock.calls.map((c) => [(c[0] as Date).getFullYear(), (c[1] as Date).getFullYear()]);
    expect(ranges[0]).toEqual([1970, 1973]);
    expect(ranges.at(-1)?.[1]).toBeGreaterThanOrEqual(2100);
    await cal.syncCalendar();
    expect(old.events.size).toBe(1);
  });

  it("marked and unmarked events: the calendar is not adopted, every event survives, a new 'Life Organizer (2)' is made", async () => {
    server.enabled = true;
    const users = fakeCalendar("user-made", "Life Organizer", ["Mum's birthday", "mine:Physics report"]);
    calendars = [users];
    const cal = await load();
    expect(await cal.enableCalendarSync()).toBe("on");
    expect([...users.events.values()].map((e) => e.title)).toEqual(["Mum's birthday", "Physics report"]);
    expect(log.filter((l) => l.startsWith("delete"))).toEqual([]);
    expect(calendarApi.createCalendar).toHaveBeenCalledWith(expect.objectContaining({ title: "Life Organizer (2)" }));
    expect(state()).toMatchObject({ calendarId: "new1", owned: true });
    expect(log).toEqual(["create Physics report"]);
  });

  it("Remove all deletes only the stored calendar we created; the user's 'Life Organizer' calendar is left alone", async () => {
    server.enabled = true;
    const users = fakeCalendar("user-made", "Life Organizer", ["Mum's birthday"]);
    calendars = [users];
    setState({ on: true, calendarId: "gone", owned: true, map: {} });
    const cal = await load();
    await cal.syncCalendar(); // stored id gone, the title match has the user's event: a new calendar is made
    expect(await cal.removeAllCalendarEvents()).toBe(true);
    expect(users.delete).not.toHaveBeenCalled();
    expect(users.events.size).toBe(1);
    expect(calendars).toEqual([users]);
    expect(state()).toMatchObject({ on: false, calendarId: null, map: {} });
  });

  it("an adopted calendar is never deleted by Remove all: only the mapped events go", async () => {
    server.enabled = true;
    const old = fakeCalendar("cal2", "Life Organizer", ["mine:Gym"]);
    calendars = [old];
    const cal = await load();
    await cal.enableCalendarSync();
    log.length = 0;
    expect(await cal.removeAllCalendarEvents()).toBe(true);
    expect(old.delete).not.toHaveBeenCalled();
    expect(log).toEqual(["delete Physics report"]);
  });

  it("Remove all with the stored calendar gone touches nothing (no title fallback)", async () => {
    const lookalike = fakeCalendar("user-made", "Life Organizer", ["mine:Gym"]);
    calendars = [lookalike];
    setState({ on: true, calendarId: "gone", owned: true, map: { "t:t1": { eventId: "x", hash: "h", start: "2026-11-06T10:00:00.000Z" } } });
    const cal = await load();
    expect(await cal.removeAllCalendarEvents()).toBe(true);
    expect(lookalike.delete).not.toHaveBeenCalled();
    expect(lookalike.events.size).toBe(1);
  });
});

describe("calendar service: the Google calendar of the signed-up account", () => {
  const ME = "huzaifa@example.com";
  const google = (events: string[] = []) => fakeCalendar("g1", ME, events, { source: { name: ME, type: "com.google" }, isPrimary: true, ownerAccount: ME });

  it("events go into the signed-up account's primary Google calendar; nothing new is created; the user's own events stay", async () => {
    server.enabled = true;
    authState.currentUser = { uid: "u1", email: ME };
    const mine = google(["Dentist"]);
    const other = fakeCalendar("g2", "other@example.com", ["Their meeting"], { source: { name: "other@example.com", type: "com.google" }, isPrimary: true, ownerAccount: "other@example.com" });
    calendars = [other, mine];
    const cal = await load();
    expect(await cal.enableCalendarSync()).toBe("on");
    expect(calendarApi.createCalendar).not.toHaveBeenCalled();
    expect([...mine.events.values()].map((e) => e.title).sort()).toEqual(["Dentist", "Physics report"]);
    expect(other.events.size).toBe(1);
    expect(state()).toMatchObject({ on: true, calendarId: "g1", owned: false });
  });

  it("moving from the local Life Organizer calendar: the app's calendar is deleted, events rebuilt in Google once", async () => {
    server.enabled = true;
    authState.currentUser = { uid: "u1", email: ME };
    const local = fakeCalendar("local1", "Life Organizer", ["mine:Physics report"]);
    const mine = google(["Dentist", "mine:Old copy"]); // a marked leftover from an earlier install
    calendars = [local, mine];
    setState({ on: true, calendarId: "local1", owned: true, map: {} });
    const cal = await load();
    await cal.syncCalendar();
    await cal.syncCalendar();
    expect(local.delete).toHaveBeenCalledTimes(1);
    expect([...mine.events.values()].map((e) => e.title).sort()).toEqual(["Dentist", "Physics report"]);
  });

  it("Remove all in the Google calendar deletes only the app's events, never the calendar or the user's events", async () => {
    server.enabled = true;
    authState.currentUser = { uid: "u1", email: ME };
    const mine = google(["Dentist"]);
    calendars = [mine];
    const cal = await load();
    await cal.enableCalendarSync();
    expect(await cal.removeAllCalendarEvents()).toBe(true);
    expect(mine.delete).not.toHaveBeenCalled();
    expect([...mine.events.values()].map((e) => e.title)).toEqual(["Dentist"]);
  });

  it("clash check: the user's own events in the Google calendar count as busy; the app's own events don't", async () => {
    server.enabled = true;
    authState.currentUser = { uid: "u1", email: ME };
    calendars = [google()];
    const at3 = { startDate: new Date("2026-11-06T10:00:00.000Z"), endDate: new Date("2026-11-06T11:00:00.000Z"), allDay: false, availability: "busy" };
    calendarApi.listEvents.mockResolvedValue([
      { ...at3, title: "Lecture", notes: "" },
      { ...at3, title: "Physics report", notes: "Created by Life Organizer" },
    ] as never);
    const cal = await load();
    await cal.enableCalendarSync();
    const hits = await cal.clashesForTask({ dueDate: "2026-11-06T00:00:00.000Z", dueTime: "3 PM", dueAt: "2026-11-06T10:00:00.000Z", scheduledStart: null, scheduledEnd: null, durationMinutes: null });
    expect(hits.map((h) => h.title)).toEqual(["Lecture"]);
  });

  it("no such account on the phone: the separate local calendar, as before", async () => {
    server.enabled = true;
    authState.currentUser = { uid: "u1", email: "someone-else@example.com" };
    calendars = [google(["Dentist"])];
    const cal = await load();
    await cal.enableCalendarSync();
    expect(calendarApi.createCalendar).toHaveBeenCalledWith(expect.objectContaining({ title: "Life Organizer" }));
  });
});
