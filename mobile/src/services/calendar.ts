import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { auth } from "../lib/firebase";
import { palettes } from "../theme/tokens";
import {
  applyOps,
  atClock,
  CALENDAR_TITLE,
  freeTitle,
  isOurEvent,
  isOurTitle,
  clashesWith,
  desiredEvents,
  expoPort,
  freeSlots,
  planOps,
  taskSpan,
  type BusyEvent,
  type EventMap,
  type Feed,
} from "../utils/calendarSync";
import { formatTime } from "../utils/format";
import { apiGet } from "./api";
import { readTasks } from "./syncEngine";

/**
 * CALENDAR_SYNC (server flag, off by default; docs/calendar.md). Writes tasks and routine occurrences into the phone's
 * own "Life Organizer" calendar and reads busy time from the phone's other calendars. Other calendars are only read,
 * never written, and nothing read from them is sent anywhere.
 *
 * expo-calendar is loaded lazily: a dev client built before this module existed has no native calendar, and the
 * import must not break the app there (the feature then reports itself unavailable).
 */

const FEATURE_KEY = "life-organizer:calendar-feature";
const stateKey = () => `life-organizer:calendar:v1:${auth.currentUser?.uid ?? "guest"}`;

/** `owned`: this app created `calendarId` (only then may Remove all delete the calendar itself). */
type State = { on: boolean; calendarId: string | null; owned: boolean; map: EventMap };
type ExpoCalendarModule = typeof import("expo-calendar");

let featureCache: boolean | null = null;
let inFlight: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;

async function readState(): Promise<State> {
  try {
    const raw = await AsyncStorage.getItem(stateKey());
    const s = raw ? (JSON.parse(raw) as Partial<State>) : {};
    return { on: Boolean(s.on), calendarId: s.calendarId ?? null, owned: s.owned === true, map: s.map && typeof s.map === "object" ? s.map : {} };
  } catch {
    return { on: false, calendarId: null, owned: false, map: {} };
  }
}

async function writeState(s: State): Promise<void> {
  try {
    await AsyncStorage.setItem(stateKey(), JSON.stringify(s));
  } catch {
    // storage unavailable: the next sync starts from the last saved map (the events are found by their ids again)
  }
}

async function loadModule(): Promise<ExpoCalendarModule | null> {
  try {
    return await import("expo-calendar");
  } catch {
    return null;
  }
}

/** The server's CALENDAR_SYNC flag, last known value when offline. False until the server says otherwise. */
export async function calendarFeatureOn(refresh = false): Promise<boolean> {
  if (featureCache !== null && !refresh) return featureCache;
  try {
    const r = await apiGet<{ enabled: boolean }>("/calendar/feed");
    featureCache = Boolean(r.enabled);
    await AsyncStorage.setItem(FEATURE_KEY, featureCache ? "1" : "0").catch(() => undefined);
  } catch {
    featureCache = (await AsyncStorage.getItem(FEATURE_KEY).catch(() => null)) === "1";
  }
  return featureCache;
}

/** The feature is on, this phone's switch is on and calendar access is still granted. */
export async function calendarSyncActive(): Promise<boolean> {
  const s = await readState();
  if (!s.on || !(await calendarFeatureOn())) return false;
  const Cal = await loadModule();
  return Boolean(Cal && (await Cal.getCalendarPermissions().catch(() => ({ granted: false }))).granted);
}

type ExpoCalendar = Awaited<ReturnType<ExpoCalendarModule["getCalendars"]>>[number];

/** Every event in a calendar, in 3-year queries (iOS caps one query at 4 years) from 1970 to 2100: no window. */
async function everyEvent(cal: ExpoCalendar) {
  const seen = new Map<string, Awaited<ReturnType<ExpoCalendar["listEvents"]>>[number]>();
  for (let y = 1970; y < 2100; y += 3) for (const e of await cal.listEvents(new Date(y, 0, 1), new Date(y + 3, 0, 1))) seen.set(e.id, e);
  return [...seen.values()];
}

/** A "Life Organizer" calendar is ours to adopt only when every event in it carries our marker; its events are returned. */
async function adoptable(cal: ExpoCalendar) {
  if (!cal.allowsModifications || !isOurTitle(cal.title)) return null;
  const events = await everyEvent(cal);
  return events.every((e) => isOurEvent(e.notes)) ? events : null;
}

/**
 * Our calendar and the state that goes with it. The stored id first. When it's gone (e.g. a reinstall cleared the
 * app's storage), a "Life Organizer" calendar whose events all carry our marker is adopted: those events are deleted,
 * since without the map they can't be matched and rebuilding next to them would duplicate everything. A calendar with
 * any unmarked event (the user's own) is never adopted or touched; a new one is created, "Life Organizer (2)" if the
 * name is taken.
 */
async function resolveCalendar(Cal: ExpoCalendarModule, s: State): Promise<{ cal: ExpoCalendar; state: State }> {
  const calendars = await Cal.getCalendars(Cal.EntityTypes.EVENT);
  const stored = s.calendarId ? calendars.find((c) => c.id === s.calendarId) : undefined;
  if (stored) return { cal: stored, state: s };
  for (const c of calendars) {
    const events = await adoptable(c);
    if (!events) continue;
    for (const e of events) await e.delete().catch(() => undefined);
    return { cal: c, state: { ...s, calendarId: c.id, owned: false, map: {} } };
  }
  const title = freeTitle(calendars.map((c) => c.title));
  const source = Platform.OS === "ios" ? Cal.getDefaultCalendarSync().source : { isLocalAccount: true, name: CALENDAR_TITLE, type: "LOCAL" };
  const cal = await Cal.createCalendar({
    title,
    name: "life-organizer",
    color: palettes.light.accent,
    entityType: Cal.EntityTypes.EVENT,
    ...(Platform.OS === "ios" ? { sourceId: source.id } : {}),
    source,
    ownerAccount: "personal",
    accessLevel: Cal.CalendarAccessLevel.OWNER,
  });
  return { cal, state: { ...s, calendarId: cal.id, owned: true, map: {} } };
}

export type EnableResult = "on" | "denied" | "unavailable";

/** Turns the switch on: asks for calendar access (the reason is in the OS dialog), finds or makes our calendar, syncs. */
export async function enableCalendarSync(): Promise<EnableResult> {
  const Cal = await loadModule();
  if (!Cal) return "unavailable";
  try {
    const perm = await Cal.requestCalendarPermissions();
    if (!perm.granted) return "denied";
    const { state } = await resolveCalendar(Cal, await readState());
    await writeState({ ...state, on: true });
  } catch (error) {
    console.warn("Calendar could not be set up", error);
    return "unavailable";
  }
  await syncCalendar();
  return "on";
}

/** Stops updating the calendar. Events already there stay (Remove all clears them). */
export async function disableCalendarSync(): Promise<void> {
  await writeState({ ...(await readState()), on: false });
}

/** How many events "Remove all" would delete (the preview). */
export async function ourEventCount(): Promise<number> {
  return Object.keys((await readState()).map).length;
}

/**
 * "Remove all Life Organizer events": only the stored calendar is touched. One this app created is deleted with all its
 * events; an adopted one (found by title, maybe not ours) keeps the calendar and loses only the events in the map.
 * The switch goes off. Undo = turn it on again, which re-creates the current tasks and routine occurrences.
 */
export async function removeAllCalendarEvents(): Promise<boolean> {
  const Cal = await loadModule();
  const s = await readState();
  if (!Cal) return false;
  try {
    const cal = s.calendarId ? (await Cal.getCalendars(Cal.EntityTypes.EVENT)).find((c) => c.id === s.calendarId) : undefined;
    if (cal && s.owned) await cal.delete();
    else if (cal) for (const { eventId } of Object.values(s.map)) await Cal.ExpoCalendarEvent.get(eventId).then((e) => e.delete()).catch(() => undefined);
  } catch (error) {
    console.warn("Could not remove the Life Organizer events", error);
    return false;
  }
  await writeState({ on: false, calendarId: null, owned: false, map: {} });
  return true;
}

async function runSync(): Promise<void> {
  const s = await readState();
  if (!s.on || !auth.currentUser || !(await calendarFeatureOn())) return;
  const Cal = await loadModule();
  if (!Cal) return;
  try {
    if (!(await Cal.getCalendarPermissions()).granted) return; // revoked in system settings: nothing to do
    let feed: Feed | null = null;
    try {
      const r = await apiGet<{ enabled: boolean } & Partial<Feed>>("/calendar/feed");
      if (!r.enabled) return;
      if (r.windowStart && r.windowEnd && r.occurrences) feed = { windowStart: r.windowStart, windowEnd: r.windowEnd, occurrences: r.occurrences };
    } catch {
      feed = null; // offline: tasks still sync, routine events stay as they are
    }
    const { cal, state } = await resolveCalendar(Cal, s);
    const ops = planOps(desiredEvents(await readTasks(), feed), state.map, feed);
    if (!ops.length && state === s) return;
    const port = expoPort(cal, (id) => Cal.ExpoCalendarEvent.get(id), { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, allDayUtc: Platform.OS === "android" });
    const { map } = await applyOps(port, ops, state.map);
    await writeState({ ...state, on: true, map });
  } catch (error) {
    console.warn("Calendar sync failed", error);
  }
}

/** One sync at a time; a request during a sync runs once more after it. */
export function syncCalendar(): Promise<void> {
  if (inFlight) {
    again = true;
    return inFlight;
  }
  inFlight = runSync().finally(() => {
    inFlight = null;
    if (again) {
      again = false;
      void syncCalendar();
    }
  });
  return inFlight;
}

/** Debounced sync after task / routine changes (called with every reminder re-plan). Off: returns at once. */
export function scheduleCalendarSync(delayMs = 2000): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void syncCalendar();
  }, delayMs);
}

/* ------------------------------------------------------------------ reading (stays on the phone) */

/**
 * Events between two instants. `others`: the phone's other calendars only (clash warnings); otherwise ours too
 * (agenda, free time). Null when calendar sync isn't active or access was taken away.
 */
export async function readEvents(from: number, to: number, opts: { others?: boolean } = {}): Promise<BusyEvent[] | null> {
  if (!(await calendarSyncActive())) return null;
  const Cal = await loadModule();
  if (!Cal) return null;
  try {
    if (!(await Cal.getCalendarPermissions()).granted) return null;
    const s = await readState();
    const calendars = (await Cal.getCalendars(Cal.EntityTypes.EVENT)).filter((c) => !opts.others || c.id !== s.calendarId);
    if (!calendars.length) return [];
    const events = await Cal.listEvents(calendars, new Date(from), new Date(to));
    return events.map((e) => ({
      title: e.title || "Busy",
      start: new Date(e.startDate).getTime(),
      end: new Date(e.endDate).getTime(),
      allDay: Boolean(e.allDay),
      free: e.availability === Cal.Availability.FREE,
    }));
  } catch (error) {
    console.warn("Could not read the calendar", error);
    return null;
  }
}

/** Events on the phone's other calendars that overlap the task's time (empty when nothing to check). */
export async function clashesForTask(task: Parameters<typeof taskSpan>[0]): Promise<BusyEvent[]> {
  const span = taskSpan(task);
  if (!span) return [];
  const events = await readEvents(span.start - 86400000, span.end + 86400000, { others: true });
  return events ? clashesWith(events, span.start, span.end) : [];
}

/** The chat's Keep / Undo card for a task that clashes (null: no clash, or calendar sync isn't active). */
export async function clashCardFor(task: Parameters<typeof taskSpan>[0] & { id: string }): Promise<{ type: "calendar_clash"; taskId: string; title: string; time: string; more: number } | null> {
  const hits = await clashesForTask(task);
  if (!hits.length) return null;
  return { type: "calendar_clash", taskId: task.id, title: hits[0].title, time: formatTime(new Date(hits[0].start).toISOString()), more: hits.length - 1 };
}

/** Day hours for free time: 8 AM – 10 PM (local). */
export const DAY_HOURS = { from: "08:00", to: "22:00" };

export async function agendaFor(ymd: string): Promise<BusyEvent[] | null> {
  const events = await readEvents(atClock(ymd, "00:00"), atClock(ymd, "23:59") + 60000);
  return events?.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start) ?? null;
}

export async function freeTimeFor(ymd: string, now = Date.now()): Promise<Array<{ start: number; end: number }> | null> {
  const from = Math.max(atClock(ymd, DAY_HOURS.from), now);
  const to = atClock(ymd, DAY_HOURS.to);
  if (from >= to) return [];
  const events = await readEvents(atClock(ymd, "00:00"), to);
  return events ? freeSlots(events, from, to) : null;
}
