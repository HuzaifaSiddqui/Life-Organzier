import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CALENDAR_SYNC × COLLAB_TASKS on the phone, expo-calendar mocked. The task lists are the shapes the server's sync pull
 * sends at each step of a share (pinned by backend/tests/collabCalendar.test.ts).
 */
const store = new Map<string, string>();
let tasks: Array<Record<string, unknown>> = [];
const events = new Map<string, { title: string; startDate: Date }>();
let n = 0;

const ours = {
  id: "cal1",
  title: "Life Organizer",
  allowsModifications: true,
  createEvent: vi.fn(async (d: { title: string; startDate: Date }) => {
    const id = `ev${++n}`;
    events.set(id, d);
    return { id };
  }),
  listEvents: vi.fn(async () => []),
  delete: vi.fn(),
};
const eventObject = (id: string) => ({
  id,
  notes: "Created by Life Organizer",
  update: async (d: { title: string; startDate: Date }) => {
    if (!events.has(id)) throw new Error("gone");
    events.set(id, { ...events.get(id)!, ...d });
  },
  delete: async () => void events.delete(id),
});

vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async (k: string) => store.get(k) ?? null, setItem: async (k: string, v: string) => void store.set(k, v) },
}));
vi.mock("../../lib/firebase", () => ({ auth: { currentUser: { uid: "sana" } } }));
vi.mock("../../services/api", () => ({
  apiGet: async () => ({ enabled: true, windowStart: "2026-11-09T19:00:00.000Z", windowEnd: "2026-11-23T19:00:00.000Z", occurrences: [] }),
}));
vi.mock("../../services/syncEngine", () => ({ readTasks: async () => tasks }));
vi.mock("expo-calendar", () => ({
  requestCalendarPermissions: async () => ({ granted: true }),
  getCalendarPermissions: async () => ({ granted: true }),
  getCalendars: async () => [ours],
  createCalendar: vi.fn(),
  listEvents: async () => [],
  getDefaultCalendarSync: vi.fn(),
  ExpoCalendarEvent: { get: async (id: string) => eventObject(id) },
  EntityTypes: { EVENT: "event" },
  CalendarAccessLevel: { OWNER: "owner" },
  Availability: { FREE: "free" },
}));

const KEY = "life-organizer:calendar:v1:sana";
const switchOn = () => store.set(KEY, JSON.stringify({ on: true, calendarId: "cal1", owned: true, map: {} }));
const task = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  title,
  status: "PENDING",
  dueDate: "2026-11-13T00:00:00.000Z",
  dueTime: "3 PM",
  dueAt: "2026-11-13T10:00:00.000Z",
  sharedTaskId: null,
  ...over,
});
const titles = () => [...events.values()].map((e) => e.title).sort();
const load = async () => {
  vi.resetModules();
  return import("../../services/calendar");
};

beforeEach(() => {
  store.clear();
  events.clear();
  tasks = [];
  vi.clearAllMocks();
});

describe("calendar × shared tasks", () => {
  it("'Only for them': the owner's calendar gets no event (the owner has no copy)", async () => {
    switchOn();
    tasks = [task("t-own", "Buy groceries")]; // the owner's pull: their own task only, nothing for the assigned share
    const cal = await load();
    await cal.syncCalendar();
    expect(titles()).toEqual(["Buy groceries"]);
  });

  it("an accepted shared task: an event in the recipient's calendar when their switch is on, none when it's off", async () => {
    tasks = [task("t-copy", "Lab report", { sharedTaskId: "s1" })];
    let cal = await load();
    await cal.syncCalendar();
    expect(events.size).toBe(0);
    switchOn();
    cal = await load();
    await cal.syncCalendar();
    expect(titles()).toEqual(["Lab report"]);
    expect([...events.values()][0].startDate.toISOString()).toBe("2026-11-13T10:00:00.000Z");
  });

  it("removed / left / cancelled: the copy stays an ordinary task, so its event stays (once); it goes when the recipient deletes the task or declines a change", async () => {
    switchOn();
    tasks = [task("t-copy", "Lab report", { sharedTaskId: "s1" })];
    const cal = await load();
    await cal.syncCalendar();
    // Removed, left or cancelled: the next pull has the same task, unlinked.
    tasks = [task("t-copy", "Lab report", { sharedTaskId: null })];
    await cal.syncCalendar();
    expect(titles()).toEqual(["Lab report"]);
    expect(ours.createEvent).toHaveBeenCalledTimes(1);
    // The recipient deletes it (or declined the owner's change, which deletes the copy): the event goes.
    tasks = [task("t-copy", "Lab report", { status: "DELETED" })];
    await cal.syncCalendar();
    expect(events.size).toBe(0);
  });
});
