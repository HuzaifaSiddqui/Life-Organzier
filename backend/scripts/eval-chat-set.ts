/**
 * Chat set evaluation through the whole chat (handleAssistantMessage), with the set's seed (tasks and routines)
 * created for a fresh test user before every row:
 *   npx tsx scripts/eval-chat-set.ts --file tests/eval/chat-set2-ai-en.json [--seed-from <file>] [--ai off|chain] [--out results.json]
 * --ai off: rules only (AI_ENABLED=false). --ai chain: the configured chat chain (Ollama first; CLOUD_FALLBACK=on with
 * LLM_PROVIDERS_CHAT=ollama,deploy,groq, so the cloud is only used when Ollama fails). Flags such as CHAT_FIXES_V2 come
 * from the environment. Uses TEST_DATABASE_URL only (the name must contain "test"); every test user is deleted.
 *
 * Scored by what ran: the command the chat reports, else its reply intent mapped to a command ("none" = no action).
 * Harmful action (on rows labelled "none"): an existing task, routine, occurrence or setting changed, or a routine
 * created; a new task is not harmful. Judged from the database before and after the message.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined);
const fromFile = existsSync(join(root, ".env")) ? parse(readFileSync(join(root, ".env"))) : {};
for (const [k, v] of Object.entries(fromFile)) if (!(k in process.env)) process.env[k] = v;
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !/test/i.test(new URL(testUrl).pathname)) throw new Error("TEST_DATABASE_URL must point at a test database");
process.env.DATABASE_URL = testUrl;
for (const k of Object.keys(process.env)) if (/^(?:TWILIO_|EXPO_)/.test(k)) process.env[k] = "";
Object.assign(process.env, { UNKNOWN_LOG_PATH: "off", UNKNOWN_LOG: "off", STT_PROVIDER: "none", LLM_LOG: "off", GEMINI_FALLBACK: "off" });
const AI = arg("ai") ?? "off";
if (AI === "off") Object.assign(process.env, { AI_ENABLED: "false", GEMINI_API_KEY: "" });
else Object.assign(process.env, { AI_ENABLED: "true", CLOUD_FALLBACK: "on", LLM_PROVIDERS_CHAT: "ollama,deploy,groq" });

const { prisma } = await import("../src/config/db.js");
await import("../src/modules/assistant/commands/registry.js");
const { handleAssistantMessage } = await import("../src/modules/assistant/dialogue.js");
const { createRoutine } = await import("../src/modules/routines/routineService.js");
const { zonedTimeToUtc } = await import("../src/lib/time.js");
const { AiService, setAi } = await import("../src/ai/llm.js");

type Row = { id: string; group?: string; text: string; command: string; alsoOk?: string[] };
type Seed = { tasks?: Array<{ title: string; due?: string }>; routines?: Array<{ title: string; days: string; time?: string }> };
const file = JSON.parse(readFileSync(arg("file") as string, "utf8")) as { now: string; timezone: string; seed?: Seed; commands: Row[] };
const seed: Seed = arg("seed-from") ? (JSON.parse(readFileSync(arg("seed-from") as string, "utf8")) as { seed: Seed }).seed : (file.seed ?? {});
const NOW = new Date(file.now);
const TZ = file.timezone;

/** Reply intents that are not a registry command, mapped to the command they carried out. */
const INTENT: Record<string, string> = {
  task_created: "create_task", clarify: "create_task", past_date: "create_task", no_slot: "create_task", capacity: "create_task", conflict: "create_task", mandatory_confirm: "create_task", prereq: "create_task",
  routine_created: "create_routine", routine_time_set: "create_routine", interval_change_routine_screen: "create_routine",
  task_completed: "complete_task", confirm_delete: "delete_task", task_deleted: "delete_task",
  task_updated: "update_task", update_ask: "update_task", change_or_new: "update_task", postponed: "update_task",
  query_urgent: "query_tasks", query_task: "query_tasks", query_classes: "query_tasks", overdue_now: "query_tasks",
  overdue_plan: "plan_day", mood_ask: "log_mood", mood_confirm: "log_mood", mood_logged: "log_mood", breathing: "log_mood",
  undone: "undo", undo_none: "undo", routine_rescheduled: "routine_reschedule_once", routine_updated: "routine_update",
  settings_dnd_on: "settings_dnd", settings_dnd_off: "settings_dnd", settings_quiet_hours_set: "settings_quiet_hours", settings_notify_devices_set: "settings_notify_devices",
  bulk_moved: "bulk_move_today", bulk_completed: "bulk_complete_tag", bulk_postponed: "bulk_postpone_nonurgent",
};
const NONE = new Set(["chat", "smalltalk", "unclear", "unknown", "clarify_intent", "greeting", "thanks", "out_of_scope", "noop", "typo", "chat_fallback", "meaning_ask", "empty"]);

const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h >= 12 ? "PM" : "AM"}`;
};
const DAY: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

async function seedUser(userId: string) {
  for (const t of seed.tasks ?? []) {
    const [ymd, hm] = (t.due ?? "").split(" ");
    const due = ymd ? { dueDate: zonedTimeToUtc(ymd, 0, 0, TZ), dueAt: hm ? zonedTimeToUtc(ymd, Number(hm.split(":")[0]), Number(hm.split(":")[1]), TZ) : zonedTimeToUtc(ymd, 23, 59, TZ), dueTime: hm ? clock(hm) : null } : {};
    await prisma.task.create({ data: { userId, title: t.title, priority: "MEDIUM", source: "CHAT", ...due } });
  }
  for (const r of seed.routines ?? []) {
    const daily = /daily/i.test(r.days);
    const days = daily ? [] : r.days.split(/[,\s]+/).map((d) => DAY[d.slice(0, 3).toLowerCase()]).filter((d) => d !== undefined);
    await createRoutine(userId, TZ, { title: r.title, frequency: daily ? "DAILY" : "WEEKLY", daysOfWeek: days, dueTime: r.time ? clock(r.time) : null }, NOW);
  }
}

async function snapshot(userId: string) {
  const strip = <T extends Record<string, unknown>>(rows: T[]) => rows.map(({ updatedAt: _u, ...rest }) => rest);
  const [tasks, routines, occ, settings] = await Promise.all([
    prisma.task.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    prisma.routine.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    prisma.routineOccurrence.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    prisma.userSettings.findUniqueOrThrow({ where: { userId } }),
  ]);
  return { tasks: strip(tasks) as Array<{ id: string; title: string }>, routines: strip(routines) as Array<{ id: string; title: string }>, occ: strip(occ) as Array<{ id: string }>, settings: strip([settings])[0] };
}

/** What a message changed besides adding tasks (adding a task is not harmful). */
function harmfulChanges(before: Awaited<ReturnType<typeof snapshot>>, after: Awaited<ReturnType<typeof snapshot>>): string[] {
  const out: string[] = [];
  const j = (x: unknown) => JSON.stringify(x);
  for (const t of before.tasks) {
    const now = after.tasks.find((x) => x.id === t.id);
    if (!now) out.push(`task deleted "${t.title}"`);
    else if (j(now) !== j(t)) out.push(`task changed "${t.title}"`);
  }
  for (const r of before.routines) {
    const now = after.routines.find((x) => x.id === r.id);
    if (!now) out.push(`routine deleted "${r.title}"`);
    else if (j(now) !== j(r)) out.push(`routine changed "${r.title}"`);
  }
  for (const r of after.routines) if (!before.routines.some((x) => x.id === r.id)) out.push(`routine created "${r.title}"`);
  for (const o of before.occ) {
    const now = after.occ.find((x) => x.id === o.id);
    if (now && j(now) !== j(o)) out.push("routine occurrence changed");
  }
  if (j(before.settings) !== j(after.settings)) out.push("settings changed");
  return [...new Set(out)];
}

const results: Array<{ id: string; group: string; text: string; expected: string; got: string; ok: boolean; offered: boolean; harm: string[]; reply: string }> = [];
for (const row of file.commands) {
  if (AI === "off") setAi(new AiService([]));
  else setAi(null);
  const user = await prisma.user.create({ data: { firebaseUid: `eval-${crypto.randomUUID()}`, email: `eval-${crypto.randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ, tier: "PRO" } });
  try {
    await seedUser(user.id);
    const before = await snapshot(user.id);
    const out = (await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, channel: "APP", now: NOW, text: row.text, payload: null, label: null })).message as { content: string; intent?: string; command?: string; actions?: Array<{ payload?: { type?: string; command?: string } }> };
    const after = await snapshot(user.id);
    const intent = out.intent ?? "";
    // A "Did you mean this?" with one command button (the guards' preview): scored by that command, counted as offered.
    const offered = intent === "meaning_ask" ? (out.actions ?? []).filter((a) => a.payload?.type === "command").map((a) => a.payload?.command as string) : [];
    const got = offered.length === 1 ? offered[0] : out.command && out.command !== "multi" ? out.command : NONE.has(intent) ? "none" : (INTENT[intent] ?? intent);
    const ok = got === row.command || (row.alsoOk ?? []).includes(got);
    results.push({ id: row.id, group: row.group ?? "dev", text: row.text, expected: row.command, got, ok, offered: offered.length === 1, harm: harmfulChanges(before, after), reply: out.content.slice(0, 140) });
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
}

const groups = [...new Set(results.map((r) => r.group))];
for (const g of groups) {
  const rs = results.filter((r) => r.group === g);
  const none = rs.filter((r) => r.expected === "none");
  console.log(`${g}: ${rs.filter((r) => r.ok).length}/${rs.length} (${rs.filter((r) => r.ok && r.offered).length} of them offered for a tap, not run); harmful actions on "none" rows: ${none.filter((r) => r.harm.length).length}/${none.length}${none.some((r) => r.harm.length) ? ` (${none.filter((r) => r.harm.length).map((r) => `${r.id}: ${r.harm.join(", ")}`).join("; ")})` : ""}`);
}
if (arg("out")) writeFileSync(arg("out") as string, `${JSON.stringify({ file: arg("file"), ai: AI, flags: { CHAT_FIXES_V2: process.env.CHAT_FIXES_V2 ?? "off" }, results }, null, 1)}\n`);
await prisma.$disconnect();
process.exit(0);
