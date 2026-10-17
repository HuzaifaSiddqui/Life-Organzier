import { Priority, type Routine, type Task } from "@prisma/client";

/**
 * Deterministic answers for deadline and class questions (no LLM). Pure: the handler loads the data,
 * these functions pick and phrase it as short plain text that also works on WhatsApp.
 */

/** WhatsApp has no cards, so the list itself is the reply and stays short. */
export const WHATSAPP_LIST_CAP = 8;
/** The app shows a task list card under the reply. */
export const APP_LIST_CAP = 12;

export function moreLine(total: number, shown: number): string | null {
  return total > shown ? `…and ${total - shown} more` : null;
}

const PRIORITY_RANK: Record<Priority, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const time = (d: Date | null) => d?.getTime() ?? Number.POSITIVE_INFINITY;

/** Most urgent first: overdue (oldest first), then due within 24 h (soonest first), then by priority and due date. */
export function mostUrgent<T extends Pick<Task, "dueAt" | "priority">>(tasks: T[], now: Date, n = 3): T[] {
  const group = (t: T) => (t.dueAt && t.dueAt < now ? 0 : t.dueAt && t.dueAt.getTime() - now.getTime() <= 24 * 3600000 ? 1 : 2);
  return [...tasks]
    .sort((a, b) => group(a) - group(b) || (group(a) < 2 ? time(a.dueAt) - time(b.dueAt) : PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || time(a.dueAt) - time(b.dueAt)))
    .slice(0, n);
}

/** Timetable classes: created from a document (Academic, fixed time), or anything with a room or a class-like name. */
export function isClassRoutine(r: Pick<Routine, "category" | "timeLocked" | "location" | "title">): boolean {
  return (r.category === "Academic" && r.timeLocked) || Boolean(r.location) || /\b(?:class|lecture|lab|tutorial|period|seminar)\b/i.test(r.title);
}

/** "Physics, Room B-12". Old titles already end in "(Room B-12)", so the room is never printed twice. */
export function withRoom(title: string, location: string | null): string {
  if (!location || title.toLowerCase().includes(location.toLowerCase())) return title;
  return /^(?:room|rm|lab|hall|block)\b/i.test(location) ? `${title}, ${location}` : `${title}, Room ${location}`;
}

export type ClassSlot = { title: string; location: string | null; start: Date; end: Date };

const line = (c: ClassSlot, clock: (d: Date) => string) => `• ${clock(c.start)} ${withRoom(c.title, c.location)}`;

/** "Classes today: • 9:00 AM Physics, Room B-12 …" (or "No classes today."). */
export function classesForDay(slots: ClassSlot[], dayLabel: string, clock: (d: Date) => string, cap = WHATSAPP_LIST_CAP): string {
  if (!slots.length) return `No classes ${dayLabel}.`;
  const shown = slots.slice(0, cap);
  return [`Classes ${dayLabel}:`, ...shown.map((c) => line(c, clock)), moreLine(slots.length, shown.length)].filter(Boolean).join("\n");
}

/**
 * "next class" / "where is my class": the class in progress, else the next one today, with time and
 * room, then the rest of today.
 */
export function currentOrNextClass(slots: ClassSlot[], now: Date, clock: (d: Date) => string, ask: "next" | "where"): string {
  const now_ = now.getTime();
  const current = slots.find((c) => c.start.getTime() <= now_ && now_ < c.end.getTime());
  const next = slots.find((c) => c.start.getTime() > now_);
  const focus = current ?? next;
  if (!focus) return slots.length ? "No more classes today." : "No classes today.";
  const room = focus.location && !focus.title.toLowerCase().includes(focus.location.toLowerCase()) ? withRoom("", focus.location).replace(/^, /, "") : null;
  const when = current ? `now, until ${clock(focus.end)}` : `at ${clock(focus.start)}`;
  const head =
    ask === "where"
      ? room
        ? `${focus.title}: ${room}, ${when}.`
        : focus.location
          ? `${focus.title} ${when}.` // old-style title already names the room
          : `${focus.title} ${when}. The room isn't in your timetable.`
      : `${current ? "Now" : "Next"}: ${focus.title} ${when}${room ? `, ${room}` : ""}.`;
  const later = slots.filter((c) => c !== focus && c.start.getTime() > now_);
  const shown = later.slice(0, WHATSAPP_LIST_CAP - 1);
  return [head, ...(shown.length ? ["Later today:", ...shown.map((c) => line(c, clock))] : []), moreLine(later.length, shown.length)].filter(Boolean).join("\n");
}
