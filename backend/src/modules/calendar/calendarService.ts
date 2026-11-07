import { addDaysYmd, localYmd, parseClock, zonedTimeToUtc } from "../../lib/time.js";
import { generateRoutineOccurrences, occurrenceEnd, occurrenceStart, occurrencesBetween } from "../routines/routineService.js";

/**
 * CALENDAR_SYNC (default off): the phone writes tasks and routine occurrences into its own "Life Organizer"
 * calendar (expo-calendar, see docs/calendar.md). The server only supplies routine occurrences for the window;
 * tasks come from the phone's task store. Nothing from the phone's calendars is ever sent here.
 */
export const calendarSyncOn = () => process.env.CALENDAR_SYNC?.toLowerCase() === "on";

/** Days ahead the phone keeps routine occurrences in the calendar (the window occurrences are generated for). */
export const FEED_DAYS = 14;

export type FeedOccurrence = { id: string; routineId: string; title: string; start: string; end: string; allDay: boolean; status: string };
export type CalendarFeed = { windowStart: string; windowEnd: string; occurrences: FeedOccurrence[] };

/**
 * Routine occurrences from the start of today for FEED_DAYS days. Every context is included: the calendar is
 * the whole plan, not the current context's view.
 */
export async function calendarFeed(userId: string, tz: string, now = new Date()): Promise<CalendarFeed> {
  await generateRoutineOccurrences(userId, tz, FEED_DAYS, now);
  const today = localYmd(now, tz);
  const windowStart = zonedTimeToUtc(today, 0, 0, tz);
  const windowEnd = zonedTimeToUtc(addDaysYmd(today, FEED_DAYS), 0, 0, tz);
  const list = await occurrencesBetween(userId, windowStart, windowEnd, null);
  const occurrences = list
    .map((o) => {
      const start = occurrenceStart(o, tz);
      const end = occurrenceEnd(o, tz);
      return { id: o.id, routineId: o.routineId, title: o.routine.title, start: start.toISOString(), end: end.toISOString(), allDay: !parseClock(o.dueTime), status: o.status };
    })
    .filter((o) => Date.parse(o.start) >= windowStart.getTime() && Date.parse(o.start) < windowEnd.getTime());
  return { windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString(), occurrences };
}
