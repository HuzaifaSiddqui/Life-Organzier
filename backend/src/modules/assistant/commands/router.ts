import { z } from "zod";
import { getAi, type ChatMessage } from "../../../ai/llm.js";
import { extractEntities, extractTargetDay, extractTimeRange, extractWeekdays } from "../entities.js";
import { COMMANDS, getCommand } from "./registry.js";
import type { Command, CommandArgs, CommandCategory, ParseCtx } from "./types.js";

/**
 * Fallback router (AI on, rules unsure): two small schema-constrained LLM calls, area then command, over the
 * registry. The model returns a command name and argument WORDS only (which task, which tag, on/off…).
 * Dates, times, durations and weekdays are re-extracted from the user's text by entities.ts, the
 * arguments are validated with the command's zod schema, and references are resolved by code when it runs.
 */

const CATEGORIES: Array<{ id: CommandCategory; label: string }> = [
  { id: "tasks", label: "add, change, finish, delete or ask about tasks, notes, tags, subtasks, plan the day" },
  { id: "routines", label: "list, change, pause, resume, delete, skip or finish routines (recurring habits, classes)" },
  { id: "settings", label: "quiet hours, Do Not Disturb, where reminders go, language, check-ins, context" },
  { id: "insights", label: "stats: tasks completed, streak, busiest day, time per category, overdue count, vs last week" },
  { id: "bulk", label: "change many tasks at once: move all of today, complete all with a tag, delete all completed, postpone non-urgent" },
  { id: "general", label: "undo, help, telling how they feel" },
];
const CATEGORY_IDS = CATEGORIES.map((c) => c.id) as [CommandCategory, ...CommandCategory[]];

/** Argument words the model may fill. Everything time-like is the parser's job. */
const WORD_ARGS = ["ref", "title", "note", "tag", "category", "mode", "language", "devices", "action", "priority", "range", "mood"] as const;
const PARSER_ARGS = new Set(["time", "ymd", "fromYmd", "toYmd", "start", "end", "until", "minutes", "durationMinutes", "days"]);
const INTERNAL_ARGS = new Set(["text", "taskId", "routineId", "occurrenceId", "subtaskId", "taskIds", "replace", "add", "remove", "titles", "index", "name"]);

function schemaKeys(command: Command): string[] {
  const shape = (command.schema as unknown as { shape?: Record<string, unknown> }).shape;
  return shape ? Object.keys(shape) : [];
}

function argHint(command: Command): string {
  if (command.wrapped) return ["create_task", "create_routine"].includes(command.name) ? "title" : ["log_mood"].includes(command.name) ? "mood" : "ref";
  const keys = schemaKeys(command).filter((k) => !PARSER_ARGS.has(k) && !INTERNAL_ARGS.has(k));
  if (command.name === "task_tags") keys.push("tag", "action (add|remove)");
  if (command.name === "subtask_add" || command.name === "subtask_complete") keys.push("title");
  return keys.join(", ") || "none";
}

const stage1Schema = z.object({ category: z.enum([...CATEGORY_IDS, "none"]) });
const stage2Schema = (names: [string, ...string[]]) => z.object({ command: z.enum(names), args: z.record(z.string()).default({}) });

export function routerMessages(text: string, stage: 1 | 2, category?: CommandCategory): ChatMessage[] {
  if (stage === 1) {
    return [
      { role: "system", content: `You route a message sent to a student planner app to one area. Areas:\n${CATEGORIES.map((c) => `- ${c.id}: ${c.label}`).join("\n")}\n- none: chit-chat, a question about something else, or not a request to the app.\nReply as JSON {"category": "..."}.` },
      { role: "user", content: text },
    ];
  }
  const list = COMMANDS.filter((c) => c.category === category);
  return [
    {
      role: "system",
      content:
        `Pick the one command that does what the user asks, or "none".\n${list.map((c) => `- ${c.name}: ${c.summary} (args: ${argHint(c)})`).join("\n")}\n` +
        `Fill args with the user's own words: ref = the task or routine they name. Never put dates, times, days or durations in args. ` +
        `Reply as JSON {"command": "...", "args": {...}}.`,
    },
    { role: "user", content: text },
  ];
}

/** Time-like arguments, from the parser only. */
function parserArgs(text: string, ctx: ParseCtx): CommandArgs {
  const e = extractEntities(text, ctx.opts);
  const range = extractTimeRange(text);
  const target = extractTargetDay(text, ctx.opts);
  const out: CommandArgs = {
    time: e.timeExplicit ? e.time : undefined,
    until: e.timeExplicit ? e.time : undefined,
    ymd: target ?? undefined,
    toYmd: target && target > ctx.todayYmd ? target : undefined,
    start: range?.start,
    end: range?.end,
    minutes: e.durationMinutes ?? undefined,
    durationMinutes: e.durationMinutes ?? undefined,
    days: extractWeekdays(text) ?? undefined,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && v !== null));
}

/** The model's words → the command's argument shape (lists, lower-case tags). */
function adapt(command: Command, words: Record<string, string>): CommandArgs {
  const w = Object.fromEntries(Object.entries(words).map(([k, v]) => [k, v.trim()]).filter(([k, v]) => v && (WORD_ARGS as readonly string[]).includes(k)));
  switch (command.name) {
    case "task_tags": {
      const tag = (w.tag ?? "").replace(/^#/, "").toLowerCase();
      return tag ? { ref: w.ref ?? "", add: w.action === "remove" ? [] : [tag], remove: w.action === "remove" ? [tag] : [] } : {};
    }
    case "subtask_add":
      return w.title ? { ref: w.ref ?? "", titles: [w.title] } : {};
    case "subtask_complete":
      return w.title ? { ref: w.ref ?? "", name: w.title.toLowerCase() } : {};
    case "bulk_complete_tag":
      return w.tag ? { tag: w.tag.replace(/^#/, "").toLowerCase() } : {};
    default:
      return w;
  }
}

/** Command + validated arguments, or null (no command fits, AI off/unavailable, or the output didn't validate). */
export async function routeWithLlm(text: string, ctx: ParseCtx): Promise<{ command: string; args: CommandArgs } | null> {
  const ai = getAi();
  if (!ai.enabled || !ai.available) return null;
  const options = { maxTokens: 60, timeoutMs: 15000 };
  const first = await ai.json(routerMessages(text, 1), stage1Schema, { ...options, json: { type: "object", properties: { category: { type: "string", enum: [...CATEGORY_IDS, "none"] } }, required: ["category"] } });
  if (!first || first.category === "none") return null;
  const names = COMMANDS.filter((c) => c.category === first.category).map((c) => c.name);
  if (!names.length) return null;
  const all: [string, ...string[]] = ["none", ...names];
  const second = await ai.json(routerMessages(text, 2, first.category), stage2Schema(all), {
    ...options,
    maxTokens: 120,
    json: { type: "object", properties: { command: { type: "string", enum: all }, args: { type: "object", additionalProperties: { type: "string" } } }, required: ["command"] },
  });
  if (!second || second.command === "none") return null;
  const command = getCommand(second.command);
  if (!command) return null;
  // The rules may accept the text after all (they win); otherwise the model's words + the parser's times.
  const rules = command.wrapped ? null : command.parse(text, ctx);
  const keys = new Set(schemaKeys(command));
  const fromParser = Object.fromEntries(Object.entries(parserArgs(text, ctx)).filter(([k]) => keys.has(k)));
  const args: CommandArgs = rules ?? { ...(command.wrapped ? { text } : {}), ...adapt(command, second.args ?? {}), ...fromParser };
  const valid = command.schema.safeParse(args);
  return valid.success ? { command: command.name, args: valid.data } : null;
}
