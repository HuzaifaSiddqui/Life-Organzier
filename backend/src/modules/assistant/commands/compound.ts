import { Priority, TaskSource, type Task } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../../config/db.js";
import { fuzzySimilarity, truncate } from "../../../lib/text.js";
import { dueDateFromYmd, relativeDayLabel } from "../../../lib/time.js";
import { createTask } from "../../tasks/taskService.js";
import { sayAction } from "../actions.js";
import { chatFixesOn } from "../chatFixes.js";
import { focusOn, taskCard } from "../dialogue.js";
import { wordMatch } from "../draft.js";
import { cleanTitle, extractEntities } from "../entities.js";
import { IMPERATIVE_START } from "../nlu.js";
import { recordUndo, UNDO_ACTION } from "./runtime.js";
import type { Command } from "./types.js";

/**
 * PR B (CHAT_FIXES_V2): two new tasks in one message, "add dentist on friday at 4 pm and call the bank tomorrow".
 * Only when it starts with an add cue, the second part starts with a verb (or its own cue), and each part has its own
 * date or time ("buy bread and eggs tomorrow" stays one task). One preview for both, one Undo step for both.
 * Never a silent duplicate: when a part matches an open task, nothing is added here; each part is offered as its own
 * message, which goes through the usual flow (and its own checks).
 * ponytail: two parts only; three or more stay one task as before.
 */
const CUE = /^(?:please\s+)?(?:add|create|schedule|remind me(?:\s+to)?)\s+/i;
const SECOND = /^(?:also\s+|then\s+)?(?:(?:add|create|schedule|remind me(?:\s+to)?)\s+)?/i;

type Part = { text: string; title: string; date: string | null; time: string | null };

function part(text: string, opts: Parameters<typeof extractEntities>[1]): Part | null {
  const e = extractEntities(text, opts);
  const title = cleanTitle(e.residual).replace(/^(?:add|create|schedule|remind me(?: to)?)\s+/i, "").trim();
  if (!(e.date || e.time) || title.length < 2) return null;
  return { text, title: title.charAt(0).toUpperCase() + title.slice(1), date: e.date?.ymd ?? null, time: e.time ?? null };
}

export function parseTwoTasks(text: string, opts: Parameters<typeof extractEntities>[1]): Part[] | null {
  const t = text.trim().replace(/[.!]+$/, "");
  if (!CUE.test(t)) return null;
  const m = /^(.+?)\s+and\s+(.+)$/i.exec(t);
  if (!m) return null;
  const second = m[2].replace(SECOND, "");
  if (!(IMPERATIVE_START.test(second) || second !== m[2])) return null;
  const a = part(m[1], opts);
  const b = part(m[2], opts);
  return a && b ? [a, b] : null;
}

const when = (p: Part, today: string) => [p.date ? relativeDayLabel(p.date, today) : p.time ? "today" : null, p.time].filter(Boolean).join(", ");

export const createTasks: Command = {
  name: "create_tasks",
  category: "tasks",
  summary: "Add two tasks in one message",
  enabled: chatFixesOn,
  examples: ["Add dentist on Friday at 4 PM and call the bank tomorrow"],
  schema: z.object({ tasks: z.array(z.object({ text: z.string(), title: z.string(), date: z.string().nullable(), time: z.string().nullable() })).length(2) }).passthrough(),
  undoable: true,
  parse: (text, ctx) => {
    const tasks = parseTwoTasks(text, ctx.opts);
    return tasks ? { tasks } : null;
  },
  async prepare(turn, args) {
    const parts = args.tasks as Part[];
    const open = await prisma.task.findMany({ where: { userId: turn.user.id, status: { in: ["PENDING", "IN_PROGRESS"] }, archived: false }, select: { title: true } });
    const same = (p: Part) => open.find((t) => wordMatch(p.title, t.title) > 0 || fuzzySimilarity(p.title, t.title) >= 0.6);
    const dup = parts.map(same).find(Boolean);
    if (dup) {
      return {
        out: {
          content: `That's two tasks, and "${dup.title}" is already on your list. Let's take them one at a time:`,
          actions: parts.map((p) => sayAction(truncate(p.title, 24), "create_task", p.text)),
          intent: "create_tasks_one_by_one",
        },
      };
    }
    const lines = parts.map((p) => `• ${p.title}${when(p, turn.todayYmd) ? ` (${when(p, turn.todayYmd)})` : ""}`);
    return {
      args,
      confirm: {
        question: ["Add these 2 tasks?", ...lines].join("\n"),
        actions: [
          { label: "Add both", payload: { type: "confirm_pending" }, style: "primary" },
          { label: "Cancel", payload: { type: "cancel_pending" } },
        ],
      },
    };
  },
  async execute(turn, args) {
    const parts = args.tasks as Part[];
    const made: Task[] = [];
    for (const p of parts) {
      const ymd = p.date ?? (p.time ? turn.todayYmd : null);
      made.push(await createTask(turn.task, { title: p.title, priority: Priority.MEDIUM, source: TaskSource.CHAT, ...(ymd ? { dueDate: dueDateFromYmd(ymd, turn.tz), dueTime: p.time } : {}) }));
    }
    focusOn(turn, ...made.map((t) => t.id).reverse());
    recordUndo(turn, { kind: "tasks", op: "create", taskIds: made.map((t) => t.id), label: "2 tasks added" });
    return {
      content: `Added 2 tasks: ${parts.map((p) => `"${p.title}"${when(p, turn.todayYmd) ? ` (${when(p, turn.todayYmd)})` : ""}`).join(" and ")}.`,
      cards: made.map((t) => taskCard(t)),
      actions: [UNDO_ACTION],
      intent: "tasks_created",
    };
  },
};
