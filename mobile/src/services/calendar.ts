import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState, Platform } from "react-native";
import { auth } from "../lib/firebase";
import {
  atClock,
  clashesWith,
  freeSlots,
  importCandidates,
  IMPORT_DAYS,
  isOurEvent,
  pruneDecided,
  taskFromEvent,
  taskSpan,
  type BusyEvent,
  type Decided,
  type ImportCandidate,
} from "../utils/calendarSync";
import { formatTime } from "../utils/format";
import { apiGet } from "./api";
import { readTasks } from "./syncEngine";

/**
 * CALENDAR_SYNC (server flag, off by default; docs/calendar.md). One-way: events in the phone's calendars (the next
 * IMPORT_DAYS days) are offered as tasks, and the user adds or skips each one ("From your calendar"). The app never
 * writes to a calendar. Events are read when the app opens or comes to the foreground, and every 15 minutes while it's
 * open; nothing read from the calendar is sent to the server except the tasks the user adds.
 * Earlier versions wrote tasks into the calendar: the first sync after the update deletes those events once (only
 * events carrying the app's marker, or the separate calendar the app created itself).
 *
 * expo-calendar is loaded lazily: a dev client built before this module existed has no native calendar, and the
 * import must not break the app there (the feature then reports itself unavailable).
 */

const FEATURE_KEY = "life-organizer:calendar-feature";
const uid = () => auth.currentUser?.uid ?? "guest";
const stateKey = () => `life-organizer:calendar:v2:${uid()}`;
/** Two-way versions' state: which calendar the app wrote to and its events. Removed after the clean-up. */
const legacyKey = () => `life-organizer:calendar:v1:${uid()}`;

/** `pending`: events waiting for Add / Skip. `decided`: keys already added or skipped. */
type State = { on: boolean; decided: Decided; pending: ImportCandidate[] };
type LegacyState = { on?: boolean; calendarId?: string | null; owned?: boolean; map?: Record<string, { eventId: string }> };
type ExpoCalendarModule = typeof import("expo-calendar");

let featureCache: boolean | null = null;
let inFlight: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const DAY_MS = 86400000;
const allDayUtc = () => Platform.OS === "android";

async function readLegacy(): Promise<LegacyState | null> {
  try {
    const raw = await AsyncStorage.getItem(legacyKey());
    return raw ? (JSON.parse(raw) as LegacyState) : null;
  } catch {
    return null;
  }
}

async function readState(): Promise<State> {
  try {
    const raw = await AsyncStorage.getItem(stateKey());
    if (raw) {
      const s = JSON.parse(raw) as Partial<State>;
      return { on: Boolean(s.on), decided: s.decided && typeof s.decided === "object" ? s.decided : {}, pending: Array.isArray(s.pending) ? s.pending : [] };
    }
    // First run after the update: the switch keeps its old position.
    return { on: Boolean((await readLegacy())?.on), decided: {}, pending: [] };
  } catch {
    return { on: false, decided: {}, pending: [] };
  }
}

async function writeState(s: State): Promise<void> {
  try {
    await AsyncStorage.setItem(stateKey(), JSON.stringify(s));
  } catch {
    // storage unavailable: events may be offered again next time
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

/**
 * Removes what the two-way versions wrote, once: the separate calendar the app created, or (in any other calendar it
 * used, e.g. the user's Google calendar) only the events carrying the app's marker. The user's own events are never
 * touched. Done when the old state is gone; a failure leaves it for the next sync.
 */
async function cleanUpLegacy(Cal: ExpoCalendarModule): Promise<void> {
  const old = await readLegacy();
  if (!old) return;
  const cal = old.calendarId ? (await Cal.getCalendars(Cal.EntityTypes.EVENT)).find((c) => c.id === old.calendarId) : undefined;
  if (cal && old.owned) await cal.delete();
  else if (cal) {
    for (const { eventId } of Object.values(old.map ?? {})) await Cal.ExpoCalendarEvent.get(eventId).then((e) => e.delete()).catch(() => undefined);
    for (const e of await everyEvent(cal)) if (isOurEvent(e.notes)) await e.delete().catch(() => undefined);
  }
  // The switch keeps its old position once the old state is gone.
  if (!(await AsyncStorage.getItem(stateKey()))) await writeState({ on: Boolean(old.on), decided: {}, pending: [] });
  await AsyncStorage.removeItem(legacyKey());
}

export type EnableResult = "on" | "denied" | "unavailable";

/** Turns the switch on: asks for calendar access (the reason is in the OS dialog), then looks for events. */
export async function enableCalendarSync(): Promise<EnableResult> {
  const Cal = await loadModule();
  if (!Cal) return "unavailable";
  try {
    const perm = await Cal.requestCalendarPermissions();
    if (!perm.granted) return "denied";
    await writeState({ ...(await readState()), on: true });
  } catch (error) {
    console.warn("Calendar could not be set up", error);
    return "unavailable";
  }
  await syncCalendar();
  return "on";
}

/** Stops reading the calendar; events waiting for a decision are dropped. */
export async function disableCalendarSync(): Promise<void> {
  await writeState({ ...(await readState()), on: false, pending: [] });
  notify([]);
}

const importListeners = new Set<(pending: ImportCandidate[]) => void>();
function notify(pending: ImportCandidate[]) {
  importListeners.forEach((l) => l(pending));
}

/** Events waiting for Add / Skip; the listener runs after every sync that changes them and after every decision. */
export function subscribeCalendarImports(listener: (pending: ImportCandidate[]) => void): () => void {
  importListeners.add(listener);
  return () => importListeners.delete(listener);
}

/** Events waiting for Add / Skip (ones that ended meanwhile are left out). */
export async function pendingImports(now = Date.now()): Promise<ImportCandidate[]> {
  const s = await readState();
  return s.on ? s.pending.filter((c) => Date.parse(c.end) > now) : [];
}

async function decide(keys: string[]): Promise<ImportCandidate[]> {
  const s = await readState();
  const want = new Set(keys);
  const chosen = s.pending.filter((c) => want.has(c.key));
  const decided = { ...s.decided };
  for (const c of chosen) decided[c.key] = Date.parse(c.start);
  const pending = s.pending.filter((c) => !want.has(c.key));
  await writeState({ ...s, decided, pending });
  notify(pending);
  return chosen;
}

/**
 * Adds the chosen events as tasks (through the offline queue like any task). `note` goes in each task's notes
 * ("From your calendar"). Returns how many were added.
 */
export async function addImports(keys: string[], note: string): Promise<number> {
  const chosen = await decide(keys);
  const { createTask } = await import("./tasksApi"); // lazy: tasksApi → reminders → calendar
  let added = 0;
  for (const c of chosen) {
    try {
      await createTask(taskFromEvent(c, note, allDayUtc()));
      added += 1;
    } catch (error) {
      console.warn("Calendar event not added", error);
    }
  }
  return added;
}

/** Skipped events are not offered again. */
export async function skipImports(keys: string[]): Promise<void> {
  await decide(keys);
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
  if (!auth.currentUser) return;
  // Off and nothing left to clean up: no server call, no calendar call.
  if (!(await readState()).on && !(await readLegacy())) return;
  if (!(await calendarFeatureOn())) return;
  const Cal = await loadModule();
  if (!Cal) return;
  try {
    if (!(await Cal.getCalendarPermissions()).granted) return; // revoked in system settings: nothing to do
    await cleanUpLegacy(Cal).catch((error) => console.warn("Old calendar events not removed yet", error));
    const s = await readState();
    if (!s.on) return;
    const now = Date.now();
    const calendars = await Cal.getCalendars(Cal.EntityTypes.EVENT);
    const events = calendars.length ? await Cal.listEvents(calendars, new Date(now - DAY_MS), new Date(now + IMPORT_DAYS * DAY_MS)) : [];
    const pending = importCandidates(events, s.decided, await readTasks(), now, { allDayUtc: allDayUtc() });
    const next: State = { on: true, decided: pruneDecided(s.decided, now), pending };
    if (JSON.stringify(next) === JSON.stringify(s)) return;
    await writeState(next);
    notify(pending);
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
 * Events between two instants. `others`: leave out events older versions of the app wrote (until the clean-up has
 * run); otherwise all. Null when calendar sync isn't active or access was taken away.
 */
export async function readEvents(from: number, to: number, opts: { others?: boolean } = {}): Promise<BusyEvent[] | null> {
  if (!(await calendarSyncActive())) return null;
  const Cal = await loadModule();
  if (!Cal) return null;
  try {
    if (!(await Cal.getCalendarPermissions()).granted) return null;
    const calendars = await Cal.getCalendars(Cal.EntityTypes.EVENT);
    if (!calendars.length) return [];
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

/** Events on the phone's calendars that overlap the task's time (empty when nothing to check). */
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
