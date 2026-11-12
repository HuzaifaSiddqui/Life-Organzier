import type { DesktopReminder } from "./bridge";

/** Most reminders the shell keeps (the app sends at most 200). */
export const MAX_ITEMS = 250;
/** A reminder missed by up to this much (laptop asleep, app just started) still fires, late; older ones are dropped. */
export const LATE_GRACE_MS = 15 * 60000;
/** setTimeout's limit (~24.8 days); later items wait for the next re-plan. */
export const MAX_DELAY_MS = 2 ** 31 - 1;

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);

/** Untrusted IPC input → valid reminders only (ids unique, dates parseable, text bounded). */
export function sanitizeReminders(input: unknown): DesktopReminder[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: DesktopReminder[] = [];
  for (const raw of input.slice(0, MAX_ITEMS)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = str(r.id, 200);
    const fireAt = str(r.fireAt, 40);
    const title = str(r.title, 300);
    const body = str(r.body, 1000);
    if (!id || !fireAt || title === null || body === null || seen.has(id) || Number.isNaN(Date.parse(fireAt))) continue;
    const kind = r.kind === "checkin" ? "checkin" : "reminder";
    seen.add(id);
    out.push({
      id,
      fireAt,
      title,
      body,
      taskId: str(r.taskId, 200),
      routineOccurrenceId: str(r.routineOccurrenceId, 200),
      kind,
      ...(str(r.checkinId, 200) ? { checkinId: r.checkinId as string } : {}),
      ...(str(r.category, 40) ? { category: r.category as string } : {}),
    });
  }
  return out;
}

/**
 * When each reminder should fire from `now`: due ones (within the late grace) get delay 0, future ones their delay,
 * anything older than the grace or beyond the timer limit is left out. Soonest first.
 */
export function planTimers(items: DesktopReminder[], now: number): Array<{ item: DesktopReminder; delay: number }> {
  return items
    .map((item) => ({ item, delay: Date.parse(item.fireAt) - now }))
    .filter(({ delay }) => delay >= -LATE_GRACE_MS && delay <= MAX_DELAY_MS)
    .map(({ item, delay }) => ({ item, delay: Math.max(0, delay) }))
    .sort((a, b) => a.delay - b.delay);
}
