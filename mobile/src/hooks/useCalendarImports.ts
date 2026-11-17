import { useEffect, useState } from "react";
import { pendingImports, subscribeCalendarImports } from "../services/calendar";
import type { ImportCandidate } from "../utils/calendarSync";

/** CALENDAR_SYNC (one-way): phone-calendar events waiting for Add / Skip; updates after every sync and decision. */
export function useCalendarImports(): ImportCandidate[] {
  const [pending, setPending] = useState<ImportCandidate[]>([]);
  useEffect(() => {
    let live = true;
    void pendingImports().then((p) => live && setPending(p));
    const off = subscribeCalendarImports((p) => setPending(p));
    return () => {
      live = false;
      off();
    };
  }, []);
  return pending;
}
