import { z } from "zod";
import { dayName, formatClock } from "../../../lib/time.js";
import { formatDuration, plural } from "../../../lib/text.js";
import { completionStreak, getAnalytics, timeByCategory } from "../../analytics/analyticsService.js";
import { PREDEFINED_CATEGORIES } from "../../settings/settingsRoutes.js";
import type { Out } from "../dialogue.js";
import { has, norm } from "./lexicon.js";
import type { Command } from "./types.js";

/**
 * Read-only insights (FR-AN-001/002), all deterministic: counts come from the analytics service, never
 * from the LLM. "This week" / "this month" are the analytics ranges: the last 7 / 30 days.
 */

const HOW_MANY = "how many|count|number of|total|kitne|kitni|کتنے|کتنی";
const MONTH = "month|this month|mahine|maheene|mahina|مہینے|مہینہ";
const range = (t: string): "week" | "month" => (has(t, MONTH) ? "month" : "week");
const rangeLabel = (r: "week" | "month") => (r === "week" ? "in the last 7 days" : "in the last 30 days");
const OPEN_INSIGHTS = { label: "Open insights", payload: { type: "navigate" as const, screen: "Insights" } };
const none = z.object({}).passthrough();

const streak: Command = {
  name: "insights_streak",
  category: "insights",
  summary: "Your streak: days in a row with something done",
  examples: ["What's my streak?", "meri streak kitni hai"],
  schema: none,
  undoable: false,
  parse: (text) => (has(norm(text), "streak|in a row|consecutive|lagataar|lagatar|musalsal|مسلسل|سٹریک|اسٹریک") ? {} : null),
  async execute(turn) {
    const s = await completionStreak(turn.user.id, turn.tz, turn.now);
    const content = !s.days
      ? "No streak yet. Finish one task or routine today to start one."
      : `${plural(s.days, "day")} in a row with something done.${s.includesToday ? "" : " Finish something today to keep it going."}`;
    return { content, intent: "insights_streak" };
  },
};

const compareWeek: Command = {
  name: "insights_compare_week",
  category: "insights",
  summary: "This week compared with last week",
  examples: ["How did I do compared to last week?"],
  schema: none,
  undoable: false,
  parse: (text) =>
    has(norm(text), "compared to last week|compared with last week|compare to last week|compare with last week|vs last week|versus last week|than last week|last week vs|this week vs|pichle hafte se|pichle hafte ke muqable|pichle hafte ke mukable|pichle hafte ke muqabale|پچھلے ہفتے") ? {} : null,
  async execute(turn) {
    const a = await getAnalytics(turn.user.id, turn.tz, "week", turn.now);
    const prev = a.previous ?? { completed: 0, completionRate: 0 };
    const diff = a.totals.completed - prev.completed;
    const trend = diff > 0 ? `${plural(diff, "more task")} than the week before. Nice!` : diff < 0 ? `${plural(-diff, "fewer task")} than the week before.` : "the same as the week before.";
    return {
      content: `Last 7 days: ${plural(a.totals.completed, "task")} done (${a.totals.completionRate}% of what was due or added). The 7 days before: ${prev.completed} (${prev.completionRate}%). That's ${trend}`,
      actions: [OPEN_INSIGHTS],
      intent: "insights_compare_week",
    };
  },
};

const overdue: Command = {
  name: "insights_overdue",
  category: "insights",
  summary: "How many tasks are overdue",
  examples: ["How many tasks are overdue?"],
  schema: none,
  undoable: false,
  parse(text) {
    const t = norm(text);
    return has(t, "overdue|over due|past due|late|لیٹ|اوور ڈیو") && (has(t, HOW_MANY) || /^overdue (?:count|number|total)$/.test(t)) ? {} : null;
  },
  async execute(turn) {
    const a = await getAnalytics(turn.user.id, turn.tz, "week", turn.now);
    const n = a.totals.overdue;
    return {
      content: n ? `${plural(n, "task")} ${n === 1 ? "is" : "are"} overdue.` : "Nothing is overdue. Well done!",
      actions: n ? [{ label: "Show them", text: "What's overdue?" }, { label: "Plan my day", payload: { type: "plan_day" } }] : [],
      intent: "insights_overdue",
    };
  },
};

const CATEGORY_NAMES = PREDEFINED_CATEGORIES.map((c) => c.name);

const categoryTime: Command = {
  name: "insights_category_time",
  category: "insights",
  summary: "Time spent per category (from task durations)",
  examples: ["How much time did I spend on Academic this week?", "Time per category this month"],
  schema: z.object({ range: z.enum(["week", "month"]).default("week"), category: z.string().max(60).optional() }).passthrough(),
  undoable: false,
  parse(text) {
    const t = norm(text);
    const timeQ = has(t, "how much time|time spent|spent time|time per category|time by category|time on each|kitna waqt|kitna time|kitna samay|کتنا وقت") || (has(t, "time|waqt|وقت") && has(t, "category|categories|کیٹیگری"));
    if (!timeQ) return null;
    const named = /\bon\s+(?:the\s+)?([A-Za-z][\w-]*)/.exec(text)?.[1];
    const category = named && (CATEGORY_NAMES.some((c) => c.toLowerCase() === named.toLowerCase()) || /^[A-Z]/.test(named)) && !/^(?:each|every|all|my)$/i.test(named) ? named : undefined;
    return { range: range(t), ...(category ? { category } : {}) };
  },
  async execute(turn, args) {
    const r = args.range === "month" ? "month" : "week";
    const rows = await timeByCategory(turn.user.id, turn.tz, r, turn.now);
    const wanted = typeof args.category === "string" ? args.category.toLowerCase() : null;
    const shown = wanted ? rows.filter((x) => x.category.toLowerCase() === wanted) : rows;
    if (!shown.length) return { content: wanted ? `No ${args.category} tasks completed ${rangeLabel(r)}.` : `No tasks completed ${rangeLabel(r)} yet.`, intent: "insights_category_time" };
    const line = (x: (typeof rows)[number]) => `${x.category}: ${x.minutes ? formatDuration(x.minutes) : "no durations"} across ${plural(x.tasks, "task")}${x.untimed && x.minutes ? ` (${x.untimed} without a duration)` : ""}`;
    const content = [`Planned time of tasks you completed ${rangeLabel(r)}:`, ...shown.slice(0, 8).map(line)].join("\n");
    return { content, actions: [OPEN_INSIGHTS], intent: "insights_category_time" };
  },
};

const completed: Command = {
  name: "insights_completed",
  category: "insights",
  summary: "How many tasks you completed this week or month",
  examples: ["How many tasks did I complete this week?", "is hafte maine kitne kaam kiye?"],
  schema: z.object({ range: z.enum(["week", "month"]).default("week") }).passthrough(),
  undoable: false,
  parse(text) {
    const t = norm(text);
    const counted = has(t, HOW_MANY) && has(t, "complete|completed|finish|finished|done|did|kiye|kie|kar liye|kiye hain|mukammal|مکمل|کیے|کئے");
    const what = /\bwhat (?:did|have) i (?:get done|got done|complete|completed|finish|finished|do|done)\b/.test(t);
    return counted || what ? { range: range(t) } : null;
  },
  async execute(turn, args) {
    const r = args.range === "month" ? "month" : "week";
    const a = await getAnalytics(turn.user.id, turn.tz, r, turn.now);
    const n = a.totals.completed;
    const onTime = a.totals.onTimeRate !== null ? ` ${a.totals.onTimeRate}% of those with a deadline were on time.` : "";
    const routineDone = a.routines.reduce((s, x) => s + x.completed, 0);
    const content = n
      ? `You completed ${plural(n, "task")} ${rangeLabel(r)}.${onTime}${routineDone ? ` Plus ${plural(routineDone, "routine")} done.` : ""}`
      : `No tasks completed ${rangeLabel(r)} yet.${routineDone ? ` You did keep up ${plural(routineDone, "routine")}.` : ""}`;
    return { content, actions: [OPEN_INSIGHTS], intent: "insights_completed" } satisfies Out;
  },
};

const busiestDay: Command = {
  name: "insights_busiest_day",
  category: "insights",
  summary: "The weekday you get the most done",
  examples: ["What's my busiest day?", "Which day am I most productive?"],
  schema: none,
  undoable: false,
  parse: (text) => {
    const t = norm(text);
    return has(t, "busiest day|busiest|most productive|productive day|best day|kis din|کس دن") && (has(t, "day|din|دن") || has(t, "busiest|most productive")) ? {} : null;
  },
  async execute(turn) {
    const a = await getAnalytics(turn.user.id, turn.tz, "month", turn.now);
    const total = a.heatmap.flat().reduce((s, v) => s + v, 0);
    if (a.bestDay === null || total < 5) return { content: "I need a few more completed tasks (at least 5 in a month) before I can tell which day suits you best.", intent: "insights_busiest_day" };
    const onBest = a.heatmap[a.bestDay].reduce((s, v) => s + v, 0);
    const hour = a.bestHour !== null ? `, mostly around ${formatClock(a.bestHour, 0)}` : "";
    return { content: `You get the most done on ${dayName(a.bestDay)}s: ${onBest} of your ${total} completed tasks in the last 30 days${hour}.`, actions: [OPEN_INSIGHTS], intent: "insights_busiest_day" };
  },
};

/** Match order: the most specific questions first. */
export const insightCommands: Command[] = [streak, compareWeek, overdue, categoryTime, completed, busiestDay];
