import { expoPort } from "../calendarSync";

/**
 * A mocked expo-calendar: an ExpoCalendar whose createEvent stores events, and ExpoCalendarEvent.get for update /
 * delete (throws for an event the user deleted in the calendar app). Tests drive the sync through expoPort.
 */
export function mockExpoCalendar() {
  const events = new Map<string, { title: string; startDate: Date; endDate: Date; allDay: boolean; timeZone: string }>();
  let n = 0;
  const calls = { create: 0, update: 0, delete: 0 };
  const calendar = {
    createEvent: async (d: { title: string; startDate: Date; endDate: Date; allDay: boolean; timeZone: string }) => {
      calls.create += 1;
      const id = `ev${++n}`;
      events.set(id, d);
      return { id };
    },
  };
  const get = async (id: string) => {
    if (!events.has(id)) throw new Error("Event not found");
    return {
      ...events.get(id)!,
      update: async (d: object) => {
        calls.update += 1;
        events.set(id, { ...events.get(id)!, ...d });
      },
      delete: async () => {
        calls.delete += 1;
        events.delete(id);
      },
    };
  };
  return { events, calls, port: expoPort(calendar, get, { timeZone: "Asia/Karachi", allDayUtc: false }) };
}
