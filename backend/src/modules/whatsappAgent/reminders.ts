import type { RoutineOccurrence, Task, UserSettings, WhatsAppAgentConnection } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { formatClock, instantLabel, localParts } from "../../lib/time.js";
import type { QuickAction } from "../assistant/types.js";
import { addOutboundMessage } from "../conversations/conversationService.js";
import { logEvent } from "../events/eventService.js";
import { sendPushToUser } from "../push/pushService.js";
import { planReminders, stillAllowedAt, type PlannedReminder, type ReminderLevel } from "../reminders/reminderService.js";
import { formatReply } from "../whatsapp/inbound.js";
import { SNOOZE_LEVEL } from "../whatsapp/whatsappService.js";
import { agentRemindersEnabled } from "./config.js";
import type { AgentConnectionManager } from "./connectionManager.js";
import { CHANNEL } from "./inbound.js";
import { PRIORITY } from "./outbox.js";

/**
 * Phase 3: reminders on the user's WhatsApp Agent (Pro; on by default in BOTH mode; WHATSAPP_AGENT_REMINDERS=off
 * turns them off for the whole server). Same planner as the phone (planReminders: quiet hours, DND, mandatory routines, the
 * 60-slot cap), so WhatsApp gets exactly the reminders the phone would show.
 *
 * Modes (UserSettings.waAgentReminders): BOTH = WhatsApp and the phone (default); OFF = phone only; WHATSAPP = WhatsApp instead of phone
 * notifications (the plan tells the phone not to schedule them, so nothing arrives twice), with a push if a send
 * fails. Only connections polled by this instance are served (their send budget
 * lives here), and each reminder is claimed before it is sent, so overlapping runs never send it twice.
 *
 * Numbered actions reuse the push buttons' handlers: tasks 1 Done (complete_task), 2 Snooze 15 min (snooze_task);
 * routines 1 Done, 2 Snooze 15 min (snooze_routine), 3 Skip today (routine_occurrence).
 */

/** A reminder older than this when the job sees it is left out (the job runs every minute). */
const LATENESS_MS = 6 * 60000;
/** A reminder's numbered options can be answered this long (like the Twilio snooze window). */
const ANSWER_FOR_MS = 6 * 3600000;
const SNOOZE_MINUTES = 15;
const REPLAN_MS = 15 * 60000;

type Due = { key: string; logId: string | null; text: string; actions: QuickAction[]; taskId: string | null; occurrenceId: string | null; fireAt: Date; level: string; push: { title: string; body: string } };

// ponytail: per process; the planner result is re-read every 15 minutes or after a task/routine change.
const plans = new Map<string, { at: number; planned: PlannedReminder[] }>();
/** Test hook. */
export function resetAgentReminderState(): void {
  plans.clear();
}

async function currentPlan(userId: string, settings: UserSettings, now: Date): Promise<PlannedReminder[]> {
  const cached = plans.get(userId);
  const changed =
    cached &&
    ((await prisma.task.count({ where: { userId, updatedAt: { gt: new Date(cached.at) } } })) > 0 ||
      (await prisma.routine.count({ where: { userId, updatedAt: { gt: new Date(cached.at) } } })) > 0 ||
      (await prisma.routineOccurrence.count({ where: { userId, updatedAt: { gt: new Date(cached.at) } } })) > 0);
  if (cached && !changed && now.getTime() - cached.at < REPLAN_MS) return cached.planned;
  const planned = await planReminders(userId, settings, now);
  plans.set(userId, { at: now.getTime(), planned });
  return planned;
}

const taskActions = (taskId: string): QuickAction[] => [
  { label: "Done", payload: { type: "complete_task", taskId } },
  { label: `Snooze ${SNOOZE_MINUTES} min`, payload: { type: "snooze_task", taskId, minutes: SNOOZE_MINUTES } },
];
const routineActions = (occurrenceId: string): QuickAction[] => [
  { label: "Done", payload: { type: "routine_occurrence", occurrenceId, status: "COMPLETED" } },
  { label: `Snooze ${SNOOZE_MINUTES} min`, payload: { type: "snooze_routine", occurrenceId, minutes: SNOOZE_MINUTES } },
  { label: "Skip today", payload: { type: "routine_occurrence", occurrenceId, status: "SKIPPED" } },
];

const isOpen = (t: Task) => (t.status === "PENDING" || t.status === "IN_PROGRESS") && !t.archived && t.reminderMode !== "NONE";

/** Due task reminders (planned rows and snoozes), claimed SCHEDULED/SNOOZED → SENDING. */
async function dueTasks(userId: string, s: UserSettings, now: Date): Promise<Due[]> {
  const rows = await prisma.reminderLog.findMany({
    where: { userId, status: { in: ["SCHEDULED", "SNOOZED"] }, taskId: { not: null }, fireAt: { lte: now, gte: new Date(now.getTime() - LATENESS_MS) } },
    orderBy: { fireAt: "asc" },
    take: 20,
  });
  const out: Due[] = [];
  for (const r of rows) {
    const task = await prisma.task.findFirst({ where: { id: r.taskId as string, userId } });
    const onTime = Boolean(task?.dueAt && Math.abs(task.dueAt.getTime() - r.fireAt.getTime()) < 60000);
    const level = (r.level === SNOOZE_LEVEL ? "normal" : r.level) as ReminderLevel;
    const allowed = task && isOpen(task) && stillAllowedAt(r.fireAt, level, onTime, task.dueAt, s, s.timezone);
    const claimed = await prisma.reminderLog.updateMany({ where: { id: r.id, status: r.status }, data: { status: allowed ? "SENDING" : "SKIPPED" } });
    if (claimed.count !== 1 || !task || !allowed) continue;
    const due = task.dueAt ? ` is due ${instantLabel(task.dueAt, s.timezone, now)}` : "";
    out.push({ key: r.id, logId: r.id, text: `Reminder: ${task.title}${due}.`, actions: taskActions(task.id), taskId: task.id, occurrenceId: null, fireAt: r.fireAt, level: r.level, push: { title: task.title, body: task.dueAt ? `Due ${instantLabel(task.dueAt, s.timezone, now)}` : "Reminder" } });
  }
  return out;
}

/**
 * Due routine reminders from the plan, plus routine snoozes. Routine reminders are not stored by the planner, so
 * each one sent gets a ReminderLog row (routineOccurrenceId + fireAt); an existing row means it was handled.
 */
async function dueRoutines(userId: string, s: UserSettings, now: Date, planned: PlannedReminder[]): Promise<Due[]> {
  const window = (at: Date) => at <= now && at.getTime() >= now.getTime() - LATENESS_MS;
  const fromPlan = planned.filter((p) => p.routineOccurrenceId && window(new Date(p.fireAt)));
  const snoozes = await prisma.reminderLog.findMany({ where: { userId, status: "SNOOZED", taskId: null, routineOccurrenceId: { not: null }, fireAt: { lte: now, gte: new Date(now.getTime() - LATENESS_MS) } } });
  const out: Due[] = [];
  const occurrence = (id: string) => prisma.routineOccurrence.findFirst({ where: { id, userId }, include: { routine: true } });
  for (const p of fromPlan) {
    const fireAt = new Date(p.fireAt);
    if (await prisma.reminderLog.findFirst({ where: { userId, routineOccurrenceId: p.routineOccurrenceId, fireAt }, select: { id: true } })) continue;
    const o = await occurrence(p.routineOccurrenceId as string);
    if (!o || o.status !== "PENDING") continue;
    const row = await prisma.reminderLog.create({ data: { userId, routineOccurrenceId: o.id, fireAt, level: p.level, status: "SENDING" } });
    out.push(routineDue(row.id, o, `${p.title}: ${p.body}.`, fireAt, p.level, { title: p.title, body: p.body }));
  }
  for (const r of snoozes) {
    const claimed = await prisma.reminderLog.updateMany({ where: { id: r.id, status: "SNOOZED" }, data: { status: "SENDING" } });
    if (claimed.count !== 1) continue;
    const o = await occurrence(r.routineOccurrenceId as string);
    if (!o || o.status !== "PENDING" || !stillAllowedAt(r.fireAt, "normal", false, null, s, s.timezone)) {
      await prisma.reminderLog.update({ where: { id: r.id }, data: { status: "SKIPPED" } });
      continue;
    }
    out.push(routineDue(r.id, o, `Reminder: ${o.routine.title}.`, r.fireAt, r.level, { title: o.routine.title, body: "Snoozed reminder" }));
  }
  return out;
}

function routineDue(logId: string, o: RoutineOccurrence & { routine: { title: string } }, text: string, fireAt: Date, level: string, push: Due["push"]): Due {
  return { key: logId, logId, text, actions: routineActions(o.id), taskId: null, occurrenceId: o.id, fireAt, level, push };
}

/** One message for everything due now; the numbered options act on the first item, the others are listed. */
export function composeReminder(items: Due[]): { text: string; actions: QuickAction[] } {
  if (items.length === 1) return { text: formatReply(items[0].text, items[0].actions), actions: items[0].actions };
  const [first, ...rest] = items;
  const text = [first.text, "", "Also now:", ...rest.map((d) => `• ${d.text.replace(/^Reminder: /, "")}`), "", `Options for "${first.push.title}":`].join("\n");
  return { text: formatReply(text, first.actions), actions: first.actions };
}

async function deliverFor(manager: AgentConnectionManager, conn: WhatsAppAgentConnection, s: UserSettings, now: Date): Promise<number> {
  // The agent can only write to someone who has written to it; until then reminders stay on the phone.
  if (!conn.chatRef) return 0;
  const planned = await currentPlan(conn.userId, s, now);
  const items = [...(await dueTasks(conn.userId, s, now)), ...(await dueRoutines(conn.userId, s, now, planned))];
  if (!items.length) return 0;
  const { text, actions } = composeReminder(items);
  const outcome = await (manager.send(conn.id, text, PRIORITY.reminder) ?? Promise.resolve({ ok: false as const, error: new Error("not polling") }));
  const ids = items.map((i) => i.logId).filter((x): x is string => Boolean(x));
  if (outcome.ok) {
    await prisma.reminderLog.updateMany({ where: { id: { in: ids } }, data: { status: "SENT_WHATSAPP" } });
    await addOutboundMessage(conn.userId, CHANNEL, text, { focusTaskId: items.find((i) => i.taskId)?.taskId ?? undefined, actions: actions as unknown as Array<{ label: string; payload: Record<string, unknown> }>, expiresAt: new Date(now.getTime() + ANSWER_FOR_MS) });
    logEvent(conn.userId, "WHATSAPP_AGENT_REMINDER_SENT", items[0].taskId, { count: items.length });
    return items.length;
  }
  // Fallback: in WHATSAPP mode the phone didn't schedule these, so they go out as a push now. In BOTH mode the
  // phone already showed them. Either way the app shows why (lastError) on the WhatsApp settings screen.
  const viaPush = s.waAgentReminders === "WHATSAPP";
  if (viaPush) for (const i of items) await sendPushToUser(conn.userId, { title: i.push.title, body: i.push.body, data: { type: "reminder", taskId: i.taskId, routineOccurrenceId: i.occurrenceId } });
  await prisma.reminderLog.updateMany({ where: { id: { in: ids } }, data: { status: viaPush ? "SENT_PUSH" : "FAILED" } });
  await prisma.whatsAppAgentConnection.update({ where: { id: conn.id }, data: { lastError: "A reminder couldn't be sent on WhatsApp, so it came as a phone notification." } }).catch(() => undefined);
  logEvent(conn.userId, "WHATSAPP_AGENT_REMINDER_FALLBACK", items[0].taskId, { count: items.length, viaPush });
  return 0;
}

/** Every minute: due reminders for connected Pro users (BOTH or WHATSAPP). 0 when switched off. */
export async function sendDueAgentReminders(manager: AgentConnectionManager | null, now = new Date()): Promise<number> {
  if (!agentRemindersEnabled() || !manager) return 0;
  const conns = await prisma.whatsAppAgentConnection.findMany({ where: { status: "CONNECTED", user: { settings: { tier: "PRO", waAgentReminders: { in: ["WHATSAPP", "BOTH"] } } } }, include: { user: { include: { settings: true } } } });
  let sent = 0;
  for (const c of conns) {
    if (!manager.isPolling(c.id) || !c.user.settings) continue;
    sent += await deliverFor(manager, c, c.user.settings, now).catch((error) => {
      console.warn("WhatsApp Agent reminders failed:", error instanceof Error ? error.message : "error");
      return 0;
    });
  }
  return sent;
}

/** "Snooze 15 min" on a routine reminder: one more reminder later, never past quiet hours / DND (checked at send). */
export async function snoozeRoutineOccurrence(userId: string, occurrenceId: string, minutes: number, tz: string, now: Date): Promise<{ title: string; at: string } | null> {
  const o = await prisma.routineOccurrence.findFirst({ where: { id: occurrenceId, userId, status: "PENDING" }, include: { routine: true } });
  if (!o) return null;
  const at = new Date(now.getTime() + Math.min(240, Math.max(5, minutes)) * 60000);
  await prisma.reminderLog.create({ data: { userId, routineOccurrenceId: o.id, fireAt: at, level: SNOOZE_LEVEL, status: "SNOOZED" } });
  const p = localParts(at, tz);
  return { title: o.routine.title, at: formatClock(p.h, p.mi) };
}
