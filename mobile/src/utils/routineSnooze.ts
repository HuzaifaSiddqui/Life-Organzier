/**
 * "Snooze 15 min" on a routine notification moves that occurrence's remaining reminders. Routine reminders are
 * local notifications re-made from the server plan on every sync, so the phone keeps its snoozes and applies them
 * to each new plan: reminders after the first snooze move by 15 minutes per snooze, and the snoozed alarm comes
 * back 15 minutes after the last snooze, while the occurrence is still pending.
 */
export const SNOOZE_MINUTES = 15;
const SNOOZE_MS = SNOOZE_MINUTES * 60000;
/** Snoozes older than this are forgotten. */
const KEEP_MS = 24 * 3600000;

export type RoutineSnooze = { firstAt: number; lastAt: number; count: number; title: string; body: string };
export type Snoozes = Record<string, RoutineSnooze>;
type Planned = { id: string; routineOccurrenceId: string | null; fireAt: string };

export function addSnooze(all: Snoozes, occurrenceId: string, now: number, content: { title: string; body: string }): Snoozes {
  const prev = all[occurrenceId];
  return { ...pruneSnoozes(all, now), [occurrenceId]: { firstAt: prev?.firstAt ?? now, lastAt: now, count: (prev?.count ?? 0) + 1, ...content } };
}

export function pruneSnoozes(all: Snoozes, now: number): Snoozes {
  return Object.fromEntries(Object.entries(all).filter(([, s]) => now - s.lastAt < KEEP_MS));
}

/** The plan with snoozes applied: later reminders moved, earlier ones (already shown) dropped. */
export function applySnoozes<T extends Planned>(plan: T[], all: Snoozes): T[] {
  return plan.flatMap((r) => {
    const s = r.routineOccurrenceId ? all[r.routineOccurrenceId] : undefined;
    if (!s) return [r];
    const at = new Date(r.fireAt).getTime();
    return at <= s.firstAt ? [] : [{ ...r, fireAt: new Date(at + s.count * SNOOZE_MS).toISOString() }];
  });
}

/** The snoozed alarms to show again: still pending, and not yet due. */
export function snoozeRepeats(all: Snoozes, pending: string[], now: number): Array<{ occurrenceId: string; fireAt: string; title: string; body: string }> {
  const open = new Set(pending);
  return Object.entries(all)
    .filter(([id, s]) => open.has(id) && s.lastAt + SNOOZE_MS > now)
    .map(([occurrenceId, s]) => ({ occurrenceId, fireAt: new Date(s.lastAt + SNOOZE_MS).toISOString(), title: s.title, body: s.body }));
}
