import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState, Platform } from "react-native";
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
  pullChanges,
  taskSpan,
  type Pulled,
  type ReadEvent,
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
 * Two-way for the app's own task events: edits made in the calendar app (time, title, "✓", delete) are found when the
 * app opens or comes to the foreground, and every 15 minutes while it's open, not instantly.
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
 * The Google calendar of the account the user signed up with (matched by email), when that account is on this phone:
 * its primary, writable calendar. Android doesn't let an app create a calendar inside a Google account, so the app
 * writes its events into this one (they show in Google Calendar and sync to Google) and touches only its own events.
 */
function googleTarget(calendars: ExpoCalendar[]): ExpoCalendar | undefined {
  const email = auth.currentUser?.email?.trim().toLowerCase();
  if (!email) return undefined;
  const mine = calendars.filter((c) => c.allowsModifications && !c.source?.isLocalAccount && (c.source?.name ?? "").toLowerCase() === email);
  return mine.find((c) => c.isPrimary) ?? mine.find((c) => (c.ownerAccount ?? "").toLowerCase() === email);
}

/** Deletes what the app wrote to a calendar: the whole calendar if the app created it, else only its own (marked) events. */
async function removeOurs(Cal: ExpoCalendarModule, cal: ExpoCalendar, s: State): Promise<void> {
  if (s.owned) return cal.delete();
  for (const { eventId } of Object.values(s.map)) await Cal.ExpoCalendarEvent.get(eventId).then((e) => e.delete()).catch(() => undefined);
  for (const e of await everyEvent(cal)) if (isOurEvent(e.notes)) await e.delete().catch(() => undefined);
}

/**
 * Our calendar and the state that goes with it. The Google calendar of the signed-up account comes first (see
 * googleTarget): moving there removes what the app wrote to its previous calendar, and any marked events already in the
 * Google calendar (a reinstall lost the map), then rebuilds. Without that account, the stored id first. When it's gone (e.g. a reinstall cleared the
 * app's storage), a "Life Organizer" calendar whose events all carry our marker is adopted: those events are deleted,
 * since without the map they can't be matched and rebuilding next to them would duplicate everything. A calendar with
 * any unmarked event (the user's own) is never adopted or touched; a new one is created, "Life Organizer (2)" if the
 * name is taken.
 */
async function resolveCalendar(Cal: ExpoCalendarModule, s: State): Promise<{ cal: ExpoCalendar; state: State }> {
  const calendars = await Cal.getCalendars(Cal.EntityTypes.EVENT);
  const stored = s.calendarId ? calendars.find((c) => c.id === s.calendarId) : undefined;
  const google = googleTarget(calendars);
  if (google) {
    if (stored?.id === google.id) return { cal: google, state: s };
    if (stored) await removeOurs(Cal, stored, s);
    for (const e of await everyEvent(google)) if (isOurEvent(e.notes)) await e.delete().catch(() => undefined);
    return { cal: google, state: { ...s, calendarId: google.id, owned: false, map: {} } };
  }
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
 * events; any other (the user's Google calendar, or one adopted by title) keeps the calendar and every event the user
 * made, and loses only the app's own events. The switch goes off. Undo = turn it on again, which re-creates the current tasks and routine occurrences.
 */
export async function removeAllCalendarEvents(): Promise<boolean> {
  const Cal = await loadModule();
  const s = await readState();
  if (!Cal) return false;
  try {
    const cal = s.calendarId ? (await Cal.getCalendars(Cal.EntityTypes.EVENT)).find((c) => c.id === s.calendarId) : undefined;
    if (cal) await removeOurs(Cal, cal, s);
  } catch (error) {
    console.warn("Could not remove the Life Organizer events", error);
    return false;
  }
  await writeState({ on: false, calendarId: null, owned: false, map: {} });
  return true;
}

const changeListeners = new Set<(pulled: Pulled[]) => void>();
/** Edits found in the calendar (shown to the user as a short note). */
export function subscribeCalendarChanges(listener: (pulled: Pulled[]) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/** Sync when the app comes to the foreground, and every 15 minutes while it is open. */
export const CALENDAR_POLL_MS = 15 * 60000;
export function startCalendarWatch(): () => void {
  scheduleCalendarSync(1000);
  const app = AppState.addEventListener("change", (state) => {
    if (state === "active") scheduleCalendarSync(500);
  });
  const periodic = setInterval(() => {
    if (AppState.currentState === "active") scheduleCalendarSync(0);
  }, CALENDAR_POLL_MS);
  return () => {
    app.remove();
    clearInterval(periodic);
  };
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
    const port = expoPort(cal, (id) => Cal.ExpoCalendarEvent.get(id), { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, allDayUtc: Platform.OS === "android" });
    // Two-way: read the app's task events back and bring the user's calendar edits to the tasks first.
    let tasks = await readTasks();
    const read = new Map<string, ReadEvent | null>();
    for (const [key, e] of Object.entries(state.map)) {
      if (!key.startsWith("t:") || e.detached) continue;
      const ev = await port.readEvent(e.eventId);
      if (ev !== undefined) read.set(key, ev);
    }
    const pulled = pullChanges(state.map, read, tasks);
    const applied = pulled.pulled.filter((p) => p.kind === "apply");
    if (applied.length) {
      const { updateTask } = await import("./tasksApi"); // lazy: tasksApi → reminders → calendar
      for (const p of applied) await updateTask(p.taskId, p.changes).catch((error) => console.warn("Calendar change not applied", error));
      tasks = await readTasks();
    }
    if (pulled.pulled.length) changeListeners.forEach((l) => l(pulled.pulled));
    const ops = planOps(desiredEvents(tasks, feed), pulled.map, feed);
    if (!ops.length && state === s && JSON.stringify(pulled.map) === JSON.stringify(state.map)) return;
    const { map } = await applyOps(port, ops, pulled.map);
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
 * Events between two instants. `others`: everything except the app's own events (clash warnings); otherwise those too
 * (agenda, free time). Null when calendar sync isn't active or access was taken away.
 */
export async function readEvents(from: number, to: number, opts: { others?: boolean } = {}): Promise<BusyEvent[] | null> {
  if (!(await calendarSyncActive())) return null;
  const Cal = await loadModule();
  if (!Cal) return null;
  try {
    if (!(await Cal.getCalendarPermissions()).granted) return null;
    const calendars = await Cal.getCalendars(Cal.EntityTypes.EVENT);
    if (!calendars.length) return [];
    // `others`: leave out the app's own events by their marker, not by calendar (the Google calendar holds both).
    const events = (await Cal.listEvents(calendars, new Date(from), new Date(to))).filter((e) => !opts.others || !isOurEvent(e.notes));
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
