/**
 * FR-RN-004 evaluation report.
 *   npx tsx scripts/checkin-report.ts --from 2026-10-15 --to 2026-11-15 --exclude-users a@x.com,<id> --out ./eval-export
 * Writes checkin-log.csv and estimate-suggestions.csv (pseudonymous user ids, no titles/messages/emails)
 * to --out, prints the report and writes docs/checkin-evaluation-results.md.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { prisma } from "../src/config/db.js";
import { checkinCsv, renderReport, suggestionCsv, type CheckinRow, type EvalTask, type SuggestionRow } from "../src/modules/checkins/evaluation.js";

const { values } = parseArgs({ options: { from: { type: "string" }, to: { type: "string" }, "exclude-users": { type: "string" }, out: { type: "string", default: "./eval-export" } } });
const from = values.from ? new Date(values.from) : undefined;
const to = values.to ? new Date(values.to) : undefined;
const range = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
const pseudo = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 10);

async function main() {
  const wanted = (values["exclude-users"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const excluded = wanted.length ? await prisma.user.findMany({ where: { OR: [{ id: { in: wanted } }, { email: { in: wanted } }] }, select: { id: true } }) : [];
  const notUser = excluded.length ? { notIn: excluded.map((u) => u.id) } : undefined;

  const logs = await prisma.checkinLog.findMany({ where: { fireAt: range, ...(notUser ? { userId: notUser } : {}) }, orderBy: { fireAt: "asc" } });
  const checkins: CheckinRow[] = logs.map((l) => ({ user: pseudo(l.userId), kind: l.kind, tone: l.tone, hasFirstStep: l.hasFirstStep, copySource: l.copySource, status: l.status, response: l.response, stale: l.stale, fireAt: l.fireAt, respondedAt: l.respondedAt }));

  const events = await prisma.activityEvent.findMany({
    where: { type: { in: ["ESTIMATE_SUGGESTION_SHOWN", "ESTIMATE_SUGGESTION_ACCEPTED"] }, createdAt: range, ...(notUser ? { userId: notUser } : {}) },
    orderBy: { createdAt: "asc" },
  });
  const suggestions: SuggestionRow[] = events.map((e) => {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    return { user: pseudo(e.userId), action: e.type.endsWith("SHOWN") ? "SHOWN" : "ACCEPTED", surface: String(p.surface ?? ""), category: String(p.category ?? "Uncategorized"), original: Number(p.original), suggested: Number(p.suggested), at: e.createdAt };
  });

  const done = await prisma.task.findMany({
    where: { status: "COMPLETED", startedAt: { not: null }, completedAt: { not: null }, durationMinutes: { not: null }, createdAt: range, ...(notUser ? { userId: notUser } : {}) },
    select: { id: true, userId: true, category: true, durationMinutes: true, startedAt: true, completedAt: true, scheduledStart: true, createdAt: true },
  });
  const partial = new Set((await prisma.checkinLog.findMany({ where: { response: { startsWith: "PARTIAL_" }, taskId: { in: done.map((t) => t.id) } }, select: { taskId: true } })).map((p) => p.taskId));
  const tasks: EvalTask[] = done.map((t) => ({ user: pseudo(t.userId), createdAt: t.createdAt, category: t.category, durationMinutes: t.durationMinutes, startedAt: t.startedAt, completedAt: t.completedAt, scheduledStart: t.scheduledStart, hadPartialProgress: partial.has(t.id) }));

  const out = path.resolve(values.out as string);
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "checkin-log.csv"), checkinCsv(checkins));
  writeFileSync(path.join(out, "estimate-suggestions.csv"), suggestionCsv(suggestions));
  const report = renderReport({ checkins, suggestions, tasks, from: values.from, to: values.to, generatedAt: new Date(), excludedUsers: excluded.length });
  writeFileSync(path.resolve(import.meta.dirname, "../../docs/checkin-evaluation-results.md"), report);
  console.log(report);
  console.log(`\nCSV written to ${out}`);
}

main().finally(() => prisma.$disconnect());
