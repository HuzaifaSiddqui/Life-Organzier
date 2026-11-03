import { beforeEach, describe, expect, it, vi } from "vitest";

// services/calendar with everything native mocked: storage in a Map, the API answer chosen per test, expo-calendar spied.
const store = new Map<string, string>();
const server = { enabled: false };
const apiGet = vi.fn(async () => (server.enabled ? { enabled: true, windowStart: "2026-11-03T19:00:00.000Z", windowEnd: "2026-11-17T19:00:00.000Z", occurrences: [] } : { enabled: false }));
const created: Array<{ title: string }> = [];
const calendarApi = {
  requestCalendarPermissions: vi.fn(async () => ({ granted: true })),
  getCalendarPermissions: vi.fn(async () => ({ granted: true })),
  getCalendars: vi.fn(async () => [ours]),
  createCalendar: vi.fn(),
  listEvents: vi.fn(async () => []),
  getDefaultCalendarSync: vi.fn(),
  ExpoCalendarEvent: { get: vi.fn() },
  EntityTypes: { EVENT: "event" },
  CalendarAccessLevel: { OWNER: "owner" },
  Availability: { FREE: "free" },
};
const ours = { id: "cal1", title: "Life Organizer", allowsModifications: true, createEvent: vi.fn(async (d: { title: string }) => (created.push(d), { id: `ev${created.length}` })), delete: vi.fn() };

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

const load = async () => {
  vi.resetModules();
  return import("../../services/calendar");
};

beforeEach(() => {
  store.clear();
  created.length = 0;
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
    store.set("life-organizer:calendar:v1:u1", JSON.stringify({ on: true, calendarId: "cal1", map: {} }));
    server.enabled = false;
    const cal = await load();
    await cal.syncCalendar();
    expect(ours.createEvent).not.toHaveBeenCalled();
    expect(await cal.agendaFor("2026-11-06")).toBeNull();
    expect(calendarApi.listEvents).not.toHaveBeenCalled();
  });

  it("flag on and switch on: the task is written once to our calendar", async () => {
    store.set("life-organizer:calendar:v1:u1", JSON.stringify({ on: true, calendarId: "cal1", map: {} }));
    server.enabled = true;
    const cal = await load();
    await cal.syncCalendar();
    await cal.syncCalendar();
    expect(created.map((e) => e.title)).toEqual(["Physics report"]);
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
