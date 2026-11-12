import type { DesktopReminder } from "../services/desktopBridge";

/** The parts of GET /reminders/plan the desktop app uses (same response the phone schedules from). */
export type DesktopPlan = {
  reminders: Array<{ id: string; taskId: string | null; routineOccurrenceId: string | null; fireAt: string; title: string; body: string }>;
  checkins?: Array<{ id: string; taskId: string; fireAt: string; title: string; body: string; category: string }>;
  settings: { devices: string; viaWhatsappAgent?: boolean };
};

/** The desktop keeps more than the phone's 60 (no OS cap), but bounded. */
export const MAX_DESKTOP_REMINDERS = 200;

/** FR-AP-002 device choice: the desktop notifies only for "All devices" and "Desktop only". */
export function desktopNotifies(devices: string): boolean {
  return devices === "ALL" || devices === "DESKTOP";
}

/**
 * Plan → the notifications the desktop shell should fire: future ones only (5 s grace, like the phone), soonest
 * first, capped. WhatsApp Agent users get task/routine reminders on WhatsApp, so only check-ins stay (as on the phone).
 */
export function desktopReminderItems(plan: DesktopPlan, now: number): DesktopReminder[] {
  if (!desktopNotifies(plan.settings.devices)) return [];
  const future = (iso: string) => new Date(iso).getTime() > now + 5000;
  const reminders: DesktopReminder[] = (plan.settings.viaWhatsappAgent ? [] : plan.reminders)
    .filter((r) => future(r.fireAt))
    .map((r) => ({ id: r.id, fireAt: r.fireAt, title: r.title, body: r.body, taskId: r.taskId, routineOccurrenceId: r.routineOccurrenceId, kind: "reminder" }));
  const checkins: DesktopReminder[] = (plan.checkins ?? [])
    .filter((c) => future(c.fireAt))
    .map((c) => ({ id: `c:${c.id}`, fireAt: c.fireAt, title: c.title, body: c.body, taskId: c.taskId, routineOccurrenceId: null, kind: "checkin", checkinId: c.id, category: c.category }));
  return [...reminders, ...checkins]
    .sort((a, b) => new Date(a.fireAt).getTime() - new Date(b.fireAt).getTime())
    .slice(0, MAX_DESKTOP_REMINDERS);
}
