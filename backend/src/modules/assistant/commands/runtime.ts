import { Prisma, type RoutineFrequency, type RoutineOccurrenceStatus, type RoutinePriority } from "@prisma/client";
import { answerAction, commandAction } from "../actions.js";
import { prisma } from "../../../config/db.js";
import { fuzzySimilarity, truncate } from "../../../lib/text.js";
import { generateRoutineOccurrences, updateRoutine } from "../../routines/routineService.js";
import type { Task } from "@prisma/client";
import { changesFromSnapshot, getTaskForUser, restoreTask, snapshotOf, softDeleteTask, undoLastEdit, updateTask } from "../../tasks/taskService.js";
import type { Out, Turn } from "../dialogue.js";
import type { Understanding } from "../nlu.js";
import type { Pending, QuickAction, UndoRecord } from "../types.js";
import { commandText } from "./copy.js";
import { getCommand } from "./registry.js";
import type { CommandArgs } from "./types.js";

export const UNDO_ACTION: QuickAction = { label: "Undo", payload: { type: "undo_command" } };

/** The Undo button in the user's language. */
export function undoAction(language: string | null | undefined): QuickAction {
  return { ...UNDO_ACTION, label: commandText(language).undo };
}

type UndoInput = UndoRecord extends infer U ? (U extends unknown ? Omit<U, "at"> : never) : never;

/** Called by execute after the change is saved (the timestamp orders it against later task edits). */
export function recordUndo(turn: Turn, rec: UndoInput): void {
  turn.state.undo = { ...rec, at: new Date().toISOString() } as UndoRecord;
}

/** Fields of each task before a change, for the undo step. */
export function snapshots(tasks: Task[]): Record<string, Record<string, unknown>> {
  return Object.fromEntries(tasks.map((t) => [t.id, snapshotOf(t)]));
}

/** A confirmation (bulk preview, delete) is valid this long; a later "yes" does nothing and offers to show it again. */
export const CONFIRM_TTL_MS = 10 * 60000;

/**
 * Validates, resolves references, asks for confirmation when the command's policy requires it, then executes.
 * `text`: the user's words, kept with a confirmation so an expired one can be shown again.
 */
export async function runCommand(turn: Turn, name: string, rawArgs: CommandArgs, opts: { text?: string } = {}): Promise<Out> {
  const out = await runCommandInner(turn, name, rawArgs, opts);
  // Which command handled the turn (a fallback inside it may have handed over to another one).
  return { ...out, command: out.command ?? name };
}

async function runCommandInner(turn: Turn, name: string, rawArgs: CommandArgs, opts: { text?: string }): Promise<Out> {
  const c = commandText(turn.settings.language);
  const command = getCommand(name);
  if (!command) return { content: c.unknown, intent: "unknown_command" };
  const parsed = command.schema.safeParse(rawArgs);
  if (!parsed.success) return { content: c.invalid, intent: "invalid_args" };
  let args = parsed.data;
  if (command.prepare) {
    const p = await command.prepare(turn, args);
    if ("out" in p) return p.out;
    args = p.args;
    if (p.confirm) {
      turn.state.pending = { kind: "confirm_command", command: name, args, summary: p.confirm.question, at: turn.now.toISOString(), ...(opts.text ? { text: opts.text } : {}) };
      return {
        content: p.confirm.question,
        cards: p.confirm.cards,
        actions: [
          { label: c.yes, payload: { type: "confirm_pending" }, style: "danger" },
          { label: c.cancel, payload: { type: "cancel_pending" } },
        ],
        intent: `${name}_confirm`,
      };
    }
  }
  return command.execute(turn, args);
}

/** "Which one?" for a command: numbered options (chips in the app, "1", "2" … on WhatsApp). */
export function askChoice(turn: Turn, command: string, args: CommandArgs, field: string, candidates: Array<{ id: string; label: string }>, question: string): Out {
  const shown = candidates.slice(0, 5);
  turn.state.pending = { kind: "command_choice", command, args, field, candidates: shown };
  return { content: question, actions: shown.map((c, i) => answerAction(truncate(c.label, 32), "command_choice", String(i + 1))), intent: "command_choice" };
}

/** Answers to confirm_command / command_choice. Null = the user moved on (the question is dropped by the caller). */
export async function resolveCommandPending(turn: Turn, text: string, u: Understanding): Promise<Out | null> {
  const p = turn.state.pending;
  const c = commandText(turn.settings.language);
  if (p?.kind === "confirm_command") {
    // Only a yes or a no closes it; anything else leaves the question open (the caller re-asks or moves on).
    if (u.intent === "confirm") return confirmPending(turn, p);
    if (u.intent === "deny") {
      turn.state.pending = null;
      return { content: c.cancelled, intent: "cancel" };
    }
    return null;
  }
  if (p?.kind === "command_choice") {
    const t = text.trim().replace(/[.!?]+$/, "");
    const n = /^\d+$/.test(t) ? Number(t) : NaN;
    const best = p.candidates.map((c) => ({ c, s: fuzzySimilarity(t, c.label) })).sort((a, b) => b.s - a.s)[0];
    const chosen = n >= 1 && n <= p.candidates.length ? p.candidates[n - 1] : best && best.s >= 0.45 ? best.c : null;
    if (!chosen) {
      if (u.intent === "deny") {
        turn.state.pending = null;
        return { content: c.neverMind, intent: "cancel" };
      }
      return null;
    }
    turn.state.pending = null;
    return runCommand(turn, p.command, { ...p.args, [p.field]: chosen.id });
  }
  return null;
}

/**
 * "Yes" to a confirm_command: runs exactly the resolved args that were previewed, if the preview is less than
 * 10 minutes old. Older: nothing runs (the tasks may have changed since), and the reply offers to show it again.
 */
export async function confirmPending(turn: Turn, p: Extract<Pending, { kind: "confirm_command" }>): Promise<Out> {
  turn.state.pending = null;
  const c = commandText(turn.settings.language);
  if (p.at && turn.now.getTime() - Date.parse(p.at) > CONFIRM_TTL_MS) {
    // Shows the preview again with the same command (it is re-made from the current tasks), never re-reads the text.
    return { content: c.expired, actions: [commandAction(c.showAgain, p.command, p.args, { text: p.text, style: "primary" })], intent: "confirm_expired" };
  }
  const command = getCommand(p.command);
  return command ? command.execute(turn, p.args) : { content: c.unknown, intent: "noop" };
}

const DAY = 86400000;

/** Undo window: deletes 24 h (like task delete), other changes 15 min (like task edits). */
function undoWindow(rec: UndoRecord): number {
  return rec.kind === "routine_deleted" || (rec.kind === "tasks" && rec.op === "delete") ? DAY : 15 * 60000;
}

/**
 * True when the last command's undo step is newer than the last change to the focused task, so a plain
 * "undo" reverts the command rather than an older task edit.
 */
export async function commandUndoIsNewest(turn: Turn): Promise<boolean> {
  const rec = turn.state.undo;
  if (!rec || turn.now.getTime() - Date.parse(rec.at) > undoWindow(rec)) return false;
  const focused = turn.state.focus[0] ? await getTaskForUser(turn.user.id, turn.state.focus[0]) : null;
  return !focused || focused.updatedAt.getTime() <= Date.parse(rec.at);
}

/** Reverts the last command's undo step. Null when there is none or it is too old. */
export async function applyCommandUndo(turn: Turn): Promise<Out | null> {
  const rec = turn.state.undo;
  if (!rec) return null;
  turn.state.undo = null;
  if (turn.now.getTime() - Date.parse(rec.at) > undoWindow(rec)) return null;
  const userId = turn.user.id;
  switch (rec.kind) {
    case "settings": {
      const data: Prisma.UserSettingsUpdateInput = { ...rec.before };
      if ("dndUntil" in rec.before) data.dndUntil = rec.before.dndUntil ? new Date(String(rec.before.dndUntil)) : null;
      turn.settings = await prisma.userSettings.update({ where: { userId }, data });
      break;
    }
    case "routine": {
      const b = rec.before;
      const restored = await updateRoutine(userId, turn.tz, rec.routineId, {
        ...(b.title !== undefined ? { title: String(b.title) } : {}),
        ...(b.dueTime !== undefined ? { dueTime: (b.dueTime as string | null) ?? null } : {}),
        ...(b.frequency !== undefined ? { frequency: b.frequency as RoutineFrequency } : {}),
        ...(b.daysOfWeek !== undefined ? { daysOfWeek: (b.daysOfWeek as number[] | null) ?? null } : {}),
        ...(b.priority !== undefined ? { priority: b.priority as RoutinePriority } : {}),
        ...(b.durationMinutes !== undefined ? { durationMinutes: (b.durationMinutes as number | null) ?? null } : {}),
        ...(b.active !== undefined ? { active: Boolean(b.active) } : {}),
      });
      if (!restored) return { content: "That routine no longer exists.", intent: "undo_none" };
      break;
    }
    case "routine_deleted": {
      const s = rec.snapshot;
      await prisma.routine.create({
        data: {
          id: String(s.id),
          userId,
          title: String(s.title),
          description: (s.description as string | null) ?? null,
          frequency: s.frequency as RoutineFrequency,
          daysOfWeek: Array.isArray(s.daysOfWeek) ? (s.daysOfWeek as number[]) : Prisma.JsonNull,
          dayOfMonth: (s.dayOfMonth as number | null) ?? null,
          dueTime: (s.dueTime as string | null) ?? null,
          durationMinutes: (s.durationMinutes as number | null) ?? null,
          category: (s.category as string | null) ?? null,
          priority: s.priority as RoutinePriority,
          timeLocked: Boolean(s.timeLocked),
          locationContext: (s.locationContext as string | null) ?? null,
          location: (s.location as string | null) ?? null,
          wellnessType: (s.wellnessType as string | null) ?? null,
          active: s.active !== false,
        },
      });
      await generateRoutineOccurrences(userId, turn.tz);
      break;
    }
    case "occurrence": {
      await prisma.routineOccurrence.updateMany({
        where: { id: rec.occurrenceId, userId },
        data: { status: rec.before.status as RoutineOccurrenceStatus, occurrenceDate: new Date(rec.before.occurrenceDate), dueTime: rec.before.dueTime, completedAt: null },
      });
      break;
    }
    case "tasks": {
      for (const id of rec.taskIds) {
        if (rec.op === "edit") {
          const before = rec.before?.[id];
          if (before) await updateTask(turn.task, id, changesFromSnapshot(before));
          else await undoLastEdit(turn.task, id);
        }
        else if (rec.op === "delete") await restoreTask(turn.task, id);
        else await softDeleteTask(turn.task, id);
      }
      break;
    }
  }
  return { content: commandText(turn.settings.language).undone(rec.label), intent: "undone" };
}
