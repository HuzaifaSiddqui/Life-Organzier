/**
 * Seeded search eval for find_items: seeds a user in the TEST database (tests/eval/query-eval.json), asks every
 * question through the real chat engine with AI off, and reads the results from what the user sees (the task
 * list card and routine cards). Prints precision/recall per question type.
 * Exits 1 when a negative returns anything (or today's list), or overall precision/recall drops below 0.9.
 * Run: npm run eval:queries   (needs TEST_DATABASE_URL, a database whose name contains "test")
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const url = process.env.TEST_DATABASE_URL ?? "";
if (!/test/i.test(url)) {
  console.error("eval:queries needs TEST_DATABASE_URL pointing at a database whose name contains 'test'.");
  process.exit(1);
}
process.env.DATABASE_URL = url;
process.env.AI_ENABLED = "false";

const { prisma } = await import("../src/config/db.js");
const { AiService, setAi } = await import("../src/ai/llm.js");
const { handleAssistantMessage } = await import("../src/modules/assistant/dialogue.js");
const { addDaysYmd, localYmd, zonedTimeToUtc } = await import("../src/lib/time.js");

type Seed = {
  places: Array<{ key: string; name: string; address: string }>;
  tasks: Array<{ title: string; notes?: string; tags?: string[]; category?: string; place?: string; dueInDays?: number; priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT"; status?: "COMPLETED"; subtasks?: string[] }>;
  routines: Array<{ title: string; location?: string; dueTime: string }>;
};
type Question = { type: string; q: string; expect: string[] };
const data = JSON.parse(readFileSync(new URL("../tests/eval/query-eval.json", import.meta.url), "utf8")) as { seed: Seed; questions: Question[] };
const TZ = "Asia/Karachi";

setAi(new AiService([]));
const user = await prisma.user.create({ data: { firebaseUid: `eval-${randomUUID()}`, email: `eval-${randomUUID()}@example.test` } });
await prisma.userSettings.create({ data: { userId: user.id, tier: "PRO", timezone: TZ } });
const out: string[] = [];
let failed = false;
try {
  // Pinned clock: noon on the run's date, for the seeds and for every question (a run can't straddle midnight).
  const today = localYmd(new Date(), TZ);
  const now = zonedTimeToUtc(today, 12, 0, TZ);
  const places = new Map<string, string>();
  for (const p of data.seed.places) places.set(p.key, (await prisma.savedLocation.create({ data: { userId: user.id, name: p.name, displayAddress: p.address, latitude: 31.5, longitude: 74.3 } })).id);
  const seeded = new Set<string>();
  for (const t of data.seed.tasks) {
    const dueAt = t.dueInDays === undefined ? null : zonedTimeToUtc(addDaysYmd(today, t.dueInDays), 23, 59, TZ);
    const task = await prisma.task.create({
      data: { userId: user.id, title: t.title, description: t.notes ?? null, tags: t.tags ?? undefined, category: t.category ?? null, priority: t.priority ?? "MEDIUM", status: t.status ?? "PENDING", source: "CHAT", dueAt, ...(t.status === "COMPLETED" ? { completedAt: now } : {}) },
    });
    seeded.add(task.id);
    for (const s of t.subtasks ?? []) seeded.add((await prisma.task.create({ data: { userId: user.id, title: s, parentTaskId: task.id, priority: "LOW", source: "CHAT" } })).id);
    if (t.place) await prisma.taskLocation.create({ data: { taskId: task.id, savedLocationId: places.get(t.place) as string } });
  }
  for (const r of data.seed.routines) await prisma.routine.create({ data: { userId: user.id, title: r.title, location: r.location ?? null, frequency: "DAILY", dueTime: r.dueTime } });

  type Row = { type: string; tp: number; got: number; want: number; ok: boolean };
  const rows: Row[] = [];
  const misses: string[] = [];
  for (const question of data.questions) {
    // Each question on its own: no open question or focus carried over; anything a misread created is removed.
    await prisma.conversation.updateMany({ where: { userId: user.id }, data: { state: {} } });
    const settings = await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } });
    const r = await handleAssistantMessage({ user, settings, deviceId: null, text: question.q, channel: "APP", now });
    await prisma.task.deleteMany({ where: { userId: user.id, id: { notIn: [...seeded] } } });
    const cards = r.message.cards ?? [];
    const titles = [
      ...cards.flatMap((c) => (c.type === "task_list" ? c.tasks.map((t) => t.title) : [])),
      ...cards.flatMap((c) => (c.type === "routine" ? [String((c.routine as { title?: string }).title ?? "")] : [])),
    ];
    const todaysList = r.message.intent === "query_tasks";
    const tp = titles.filter((t) => question.expect.includes(t)).length;
    const ok = question.expect.length ? r.message.intent === "find_items" && tp === question.expect.length && titles.length === tp : r.message.intent === "find_items" && titles.length === 0;
    rows.push({ type: question.type, tp, got: titles.length, want: question.expect.length, ok });
    if (!ok) misses.push(`  ✗ [${question.type}] "${question.q}" → ${r.message.intent}${todaysList ? " (today's list!)" : ""}: got ${JSON.stringify(titles)}, want ${JSON.stringify(question.expect)}`);
  }

  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
  out.push("Query eval (find_items, AI off, seeded test user)", "", "type          n   exact   precision   recall");
  const types = [...new Set(rows.map((r) => r.type))];
  for (const type of types) {
    const rs = rows.filter((r) => r.type === type);
    const sum = (k: keyof Row) => rs.reduce((n, r) => n + (r[k] as number), 0);
    out.push(`${type.padEnd(13)} ${String(rs.length).padStart(2)}   ${String(rs.filter((r) => r.ok).length).padStart(2)}/${String(rs.length).padEnd(2)}  ${pct(sum("tp"), sum("got")).padStart(9)}   ${type === "negative" ? "  (must be empty)" : pct(sum("tp"), sum("want")).padStart(6)}`);
  }
  const positive = rows.filter((r) => r.want > 0);
  const P = positive.reduce((n, r) => n + r.tp, 0) / Math.max(1, positive.reduce((n, r) => n + r.got, 0));
  const R = positive.reduce((n, r) => n + r.tp, 0) / Math.max(1, positive.reduce((n, r) => n + r.want, 0));
  const negWrong = rows.filter((r) => r.type === "negative" && !r.ok).length;
  out.push("", `Overall (questions with an answer): precision ${(P * 100).toFixed(1)}%, recall ${(R * 100).toFixed(1)}%, exact ${positive.filter((r) => r.ok).length}/${positive.length}`);
  out.push(`Negatives returning nothing: ${rows.filter((r) => r.type === "negative" && r.ok).length}/${rows.filter((r) => r.type === "negative").length}`);
  if (misses.length) out.push("", "Misses:", ...misses);
  failed = negWrong > 0 || P < 0.9 || R < 0.9;
} finally {
  await prisma.user.delete({ where: { id: user.id } });
  await prisma.$disconnect();
}
console.log(out.join("\n"));
process.exit(failed ? 1 : 0);
