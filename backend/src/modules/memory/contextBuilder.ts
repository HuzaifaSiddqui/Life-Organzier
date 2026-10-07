import { TaskStatus, type Conversation, type User, type UserSettings } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { instantLabel, localParts, localYmd, dayName, formatClock } from "../../lib/time.js";
import { truncate } from "../../lib/text.js";
import { latestMood } from "../mood/moodService.js";
import { getPatterns, RECOMMEND_THRESHOLD } from "../patterns/patternService.js";
import { isTaskOverdue } from "../tasks/taskService.js";
import { coreMemories, recallEpisodes, retrieveMemories, type RetrievedMemory } from "./memoryService.js";

/**
 * Assembles everything the assistant knows that is relevant *right now* into a compact block
 * that fits a small local model's context:
 *   working memory (dialogue state)  → handled by the dialogue manager
 *   episodic memory                  → rolling summary + semantically recalled past messages
 *   semantic memory                  → top-k facts/preferences/coping strategies for this query
 *   behavioural memory               → learned patterns above the confidence threshold
 *   live state                       → today's workload, overdue items, latest mood, context
 */

export type AssistantContext = {
  block: string;
  memories: RetrievedMemory[];
  copingMemories: string[];
  displayName: string;
};

export async function buildAssistantContext(args: {
  user: User;
  settings: UserSettings;
  conversation: Conversation;
  query: string;
  now?: Date;
  budgetChars?: number;
}): Promise<AssistantContext> {
  const { user, settings, conversation, query } = args;
  const now = args.now ?? new Date();
  const tz = settings.timezone;
  const budget = args.budgetChars ?? 2200;

  const [memories, core, episodes, patterns, mood, tasks] = await Promise.all([
    retrieveMemories(user.id, query, { k: 5 }),
    coreMemories(user.id, 3),
    recallEpisodes(user.id, query, { k: 2 }),
    getPatterns(user.id, tz),
    latestMood(user.id, 12),
    prisma.task.findMany({
      where: { userId: user.id, status: { in: [TaskStatus.PENDING, TaskStatus.IN_PROGRESS] }, archived: false, parentTaskId: null },
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }],
      take: 40,
    }),
  ]);
  const coping = (await retrieveMemories(user.id, `${query} what helps me relax feel better when stressed`, { k: 3, kinds: ["COPING"], minRelevance: 0 }))
    .map((m) => m.content);

  const local = localParts(now, tz);
  const todayYmd = localYmd(now, tz);
  const dueToday = tasks.filter((t) => t.dueAt && localYmd(t.dueAt, tz) === todayYmd);
  const overdue = tasks.filter((t) => isTaskOverdue(t, now));
  const displayName = user.displayName?.split(/\s+/)[0] ?? user.email.split("@")[0];

  const lines: string[] = [];
  lines.push(`User: ${displayName}. Now: ${dayName(local.weekday)} ${formatClock(local.h, local.mi)} (${tz}).${settings.currentContext ? ` Current context: ${settings.currentContext}.` : ""}`);
  lines.push(
    `Workload: ${tasks.length} open tasks, ${dueToday.length} due today, ${overdue.length} overdue.` +
      (tasks[0] ? ` Next: "${truncate(tasks[0].title, 50)}"${tasks[0].dueAt ? ` due ${instantLabel(tasks[0].dueAt, tz, now)}` : ""}.` : ""),
  );
  if (mood) lines.push(`Latest mood: ${mood.mood}${mood.score ? ` (${mood.score}/10)` : ""}, ${Math.round((now.getTime() - mood.createdAt.getTime()) / 3600000)}h ago.`);

  const factLines = [...new Map([...core.map((c) => [c.id, c.content] as const), ...memories.map((m) => [m.id, m.content] as const)]).values()];
  if (factLines.length) lines.push(`What you know about the user:\n${factLines.slice(0, 7).map((f) => `- ${truncate(f, 140)}`).join("\n")}`);
  const strong = patterns.filter((p) => p.confidence >= RECOMMEND_THRESHOLD).slice(0, 3);
  if (strong.length) lines.push(`Learned patterns:\n${strong.map((p) => `- ${p.description} (${Math.round(p.confidence * 100)}% confident)`).join("\n")}`);
  if (conversation.summary) lines.push(`Earlier in this conversation: ${truncate(conversation.summary, 400)}`);
  const previous = await prisma.conversation.findFirst({
    where: { userId: user.id, id: { not: conversation.id }, summary: { not: null }, lastMessageAt: { gte: new Date(now.getTime() - 14 * 86400000) } },
    orderBy: { lastMessageAt: "desc" },
    select: { summary: true },
  });
  if (previous?.summary) lines.push(`Last conversation: ${truncate(previous.summary, 300)}`);
  if (episodes.length) lines.push(`Related things the user said before:\n${episodes.map((e) => `- "${truncate(e.content, 120)}"`).join("\n")}`);

  let block = lines.join("\n");
  if (block.length > budget) block = `${block.slice(0, budget - 1)}…`;
  return { block, memories, copingMemories: coping, displayName };
}
