/**
 * Routing accuracy (npm run eval:routing; the one definition used for reported chat numbers): chat sets through the
 * whole chat (handleAssistantMessage), with the set's seed (tasks and routines)
 * created for a fresh test user before every row:
 *   npx tsx scripts/eval-chat-set.ts --file tests/eval/chat-set2-ai-en.json [--seed-from <file>] [--ai off|chain] [--out results.json]
 * --ai off: rules only (AI_ENABLED=false). --ai chain: the configured chat chain (Ollama first; CLOUD_FALLBACK=on with
 * LLM_PROVIDERS_CHAT=ollama,deploy,groq, so the cloud is only used when Ollama fails). Flags such as CHAT_FIXES_V2 come
 * from the environment. Uses TEST_DATABASE_URL only (the name must contain "test"); every test user is deleted.
 *
 * Scored by what ran: the command the reply reports ("none" = no command handled it, a reply only).
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
const { getCommand } = await import("../src/modules/assistant/commands/registry.js");
const { handleAssistantMessage } = await import("../src/modules/assistant/dialogue.js");
const { createRoutine, generateRoutineOccurrences } = await import("../src/modules/routines/routineService.js");
const { localYmd, parseClock, zonedTimeToUtc } = await import("../src/lib/time.js");
const { AiService, setAi } = await import("../src/ai/llm.js");

type Row = { id: string; group?: string; text: string; command: string; alsoOk?: string[] };
type Seed = { tasks?: Array<{ title: string; due?: string; tags?: string[]; status?: string }>; routines?: Array<{ title: string; days: string; time?: string }> };

/**
 * End-to-end checks (--checks <file>, rows by id). mustInclude / mustNotInclude: titles in the reply text or its task
 * cards. db: the state after the turn; every change it doesn't name fails the row ("none" = nothing may change).
 * clarifyOk: "Which days do you mean?" also passes (clarifyOnly: only that); today's list never does. emptyList: the
 * answer lists nothing. listTitle: the list answered. notIntent: reply intents that fail the row.
 */
type DbCheck =
  | { op: "none" }
  | { op: "created"; title?: string; dueYmd?: string; dueTime?: string }
  | { op: "completed"; title: string }
  | { op: "updated"; title: string; dueYmd?: string; dueTime?: string; priority?: string }
  | { op: "routine"; days?: "daily" | number[]; hourFrom?: number; hourTo?: number }
  | { op: "occurrence"; routine: string; status: string }
  | { op: "routine_paused"; title: string };
/** orAsk: a question with nothing changed also passes the db check. replyMatches: a pattern the reply text must match. */
type Check = { id: string; mustInclude?: string[]; mustNotInclude?: string[]; db?: DbCheck[]; orAsk?: boolean; replyMatches?: string; clarifyOk?: boolean; clarifyOnly?: boolean; emptyList?: boolean; listTitle?: string; notIntent?: string[] };
const checks = new Map((arg("checks") ? (JSON.parse(readFileSync(arg("checks") as string, "utf8")) as { rows: Check[] }).rows : []).map((c) => [c.id, c]));
const file = JSON.parse(readFileSync(arg("file") as string, "utf8")) as { now: string; timezone: string; seed?: Seed; commands: Row[] };
const seed: Seed = arg("seed-from") ? (JSON.parse(readFileSync(arg("seed-from") as string, "utf8")) as { seed: Seed }).seed : (file.seed ?? {});
const NOW = new Date(file.now);
const TZ = file.timezone;

const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h >= 12 ? "PM" : "AM"}`;
};
const DAY: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

async function seedUser(userId: string) {
  for (const t of seed.tasks ?? []) {
    const [ymd, hm] = (t.due ?? "").split(" ");
    const due = ymd ? { dueDate: zonedTimeToUtc(ymd, 0, 0, TZ), dueAt: hm ? zonedTimeToUtc(ymd, Number(hm.split(":")[0]), Number(hm.split(":")[1]), TZ) : zonedTimeToUtc(ymd, 23, 59, TZ), dueTime: hm ? clock(hm) : null } : {};
    const done = /complete/i.test(t.status ?? "") ? { status: "COMPLETED" as const, completedAt: new Date(NOW.getTime() - 86400000) } : {};
    await prisma.task.create({ data: { userId, title: t.title, priority: "MEDIUM", source: "CHAT", ...due, ...(t.tags ? { tags: t.tags } : {}), ...done } });
  }
  for (const r of seed.routines ?? []) {
    const daily = /daily/i.test(r.days);
    const days = daily ? [] : r.days.split(/[,\s]+/).map((d) => DAY[d.slice(0, 3).toLowerCase()]).filter((d) => d !== undefined);
    await createRoutine(userId, TZ, { title: r.title, frequency: daily ? "DAILY" : "WEEKLY", daysOfWeek: days, dueTime: r.time ? clock(r.time) : null }, NOW);
  }
  // The scheduler's occurrences for the eval week, as the server would have generated them (routine rows run end to end).
  // createRoutine stamps the real clock; the set's routines existed before its "now", so back-date them first.
  if (seed.routines?.length) {
    await prisma.routine.updateMany({ where: { userId }, data: { createdAt: new Date(NOW.getTime() - 30 * 86400000) } });
    await generateRoutineOccurrences(userId, TZ, undefined, NOW);
  }
}

/** The right command ran but the outcome is not what was asked: nothing found, a "which one?", not scheduled. */
const WRONG_OUTCOME = new Set(["not_found", "choose_task", "routine_not_today"]);

type Snap = Awaited<ReturnType<typeof snapshot>>;
type TaskRow = { id: string; title: string; status: string; dueAt: Date | string | null; dueTime: string | null; priority: string };
type OccRow = { id: string; routineId: string; status: string };
type RoutineRow = { id: string; title: string; frequency: string; daysOfWeek: number[] | null; dueTime: string | null };

/** What failed for this row's checks (empty = passed). */
function checkRow(c: Check | undefined, out: { content: string; cards?: unknown[] }, intent: string, before: Snap, after: Snap): string[] {
  if (!c) return [];
  const fail: string[] = [];
  const shown = `${out.content}\n${JSON.stringify(out.cards ?? [])}`.toLowerCase();
  const lists = (out.cards ?? []).filter((x): x is { type: string; title?: string; tasks?: unknown[] } => (x as { type?: string }).type === "task_list");
  const clarifying = intent === "query_range_ask";
  if (c.clarifyOk && lists.some((l) => l.title === "Today")) fail.push("answered with today's list");
  if (c.clarifyOnly && !clarifying) fail.push("no clarifying question");
  if (!(c.clarifyOk && clarifying)) {
    for (const t of c.mustInclude ?? []) if (!shown.includes(t.toLowerCase())) fail.push(`missing "${t}"`);
    if (c.emptyList && lists.some((l) => (l.tasks ?? []).length)) fail.push("listed tasks, expected none");
    if (c.listTitle && !lists.some((l) => l.title === c.listTitle)) fail.push(`no "${c.listTitle}" list`);
  }
  for (const t of c.mustNotInclude ?? []) if (shown.includes(t.toLowerCase())) fail.push(`shows "${t}"`);
  if (c.notIntent?.includes(intent)) fail.push(`reply was ${intent}`);
  if (c.replyMatches && !new RegExp(c.replyMatches, "i").test(out.content)) fail.push(`reply doesn't say /${c.replyMatches}/`);
  if (c.db) {
    const db = checkDb(c.db, before, after);
    const asked = /\?\s*$/.test(out.content.trim()) && checkDb([{ op: "none" }], before, after).length === 0;
    if (db.length && !(c.orAsk && asked)) fail.push(...db);
  }
  return fail;
}

const ymdOf = (d: Date | string | null) => (d ? localYmd(new Date(d), TZ) : null);
const hourOf = (clock: string | null) => (clock ? (parseClock(clock)?.h ?? null) : null);

/** Every change in the database must be one the row names; anything else fails it. */
function checkDb(db: DbCheck[], before: Snap, after: Snap): string[] {
  const fail: string[] = [];
  const bt = new Map((before.tasks as unknown as TaskRow[]).map((t) => [t.id, t]));
  const at = after.tasks as unknown as TaskRow[];
  const created = at.filter((t) => !bt.has(t.id));
  const changed = at.filter((t) => bt.has(t.id) && JSON.stringify(t) !== JSON.stringify(bt.get(t.id)));
  const gone = [...bt.values()].filter((t) => !at.some((x) => x.id === t.id));
  const br = new Set(before.routines.map((r) => r.id));
  const newRoutines = (after.routines as unknown as RoutineRow[]).filter((r) => !br.has(r.id));
  const changedRoutines = after.routines.filter((r) => br.has(r.id) && JSON.stringify(r) !== JSON.stringify(before.routines.find((x) => x.id === r.id)));
  const used = new Set<string>();
  const usedOcc = new Set<string>();
  const has = (title: string, want?: string) => !want || title.toLowerCase().includes(want.toLowerCase());
  for (const d of db) {
    if (d.op === "none") continue;
    if (d.op === "created") {
      const m = created.find((t) => !used.has(t.id) && has(t.title, d.title) && (!d.dueYmd || ymdOf(t.dueAt) === d.dueYmd) && (!d.dueTime || t.dueTime === d.dueTime));
      if (m) used.add(m.id);
      else fail.push(`no new task${d.title ? ` "${d.title}"` : ""}${d.dueYmd ? ` due ${d.dueYmd}` : ""}${d.dueTime ? ` ${d.dueTime}` : ""} (created: ${created.map((t) => `${t.title} ${ymdOf(t.dueAt)} ${t.dueTime ?? ""}`).join("; ") || "none"})`);
    } else if (d.op === "completed") {
      const m = changed.find((t) => !used.has(t.id) && has(t.title, d.title) && t.status === "COMPLETED");
      if (m) used.add(m.id);
      else fail.push(`"${d.title}" not completed`);
    } else if (d.op === "updated") {
      const m = changed.find((t) => !used.has(t.id) && has(t.title, d.title) && (!d.dueYmd || ymdOf(t.dueAt) === d.dueYmd) && (!d.dueTime || t.dueTime === d.dueTime) && (!d.priority || t.priority === d.priority));
      if (m) used.add(m.id);
      else fail.push(`"${d.title}" not updated${d.dueYmd ? ` to ${d.dueYmd}` : ""}${d.dueTime ? ` at ${d.dueTime}` : ""}${d.priority ? ` (${d.priority})` : ""}`);
    } else if (d.op === "occurrence") {
      const routine = (after.routines as unknown as RoutineRow[]).find((r) => has(r.title, d.routine));
      const bo = new Map((before.occ as unknown as OccRow[]).map((o) => [o.id, o]));
      const m = (after.occ as unknown as OccRow[]).find((o) => routine && o.routineId === routine.id && o.status === d.status && bo.get(o.id)?.status !== d.status);
      if (m) usedOcc.add(m.id);
      else fail.push(`${d.routine} today is not ${d.status}`);
    } else if (d.op === "routine_paused") {
      const m = (after.routines as unknown as Array<RoutineRow & { active: boolean }>).find((r) => has(r.title, d.title) && r.active === false && before.routines.some((x) => x.id === r.id && (x as unknown as { active: boolean }).active));
      if (m) {
        used.add(m.id);
        // Pausing also settles that routine's upcoming occurrences: part of the pause, not another change.
        for (const o of after.occ as unknown as OccRow[]) if (o.routineId === m.id) usedOcc.add(o.id);
      } else fail.push(`${d.title} not paused`);
    } else if (d.op === "routine") {
      const m = newRoutines.find((r) => {
        if (used.has(r.id)) return false;
        const days = r.frequency === "DAILY" || (r.daysOfWeek ?? []).length === 7 ? "daily" : JSON.stringify([...(r.daysOfWeek ?? [])].sort());
        const okDays = !d.days || (d.days === "daily" ? days === "daily" : days === JSON.stringify([...d.days].sort()));
        const h = hourOf(r.dueTime);
        return okDays && (d.hourFrom === undefined || (h !== null && h >= d.hourFrom && h <= (d.hourTo ?? d.hourFrom)));
      });
      if (m) used.add(m.id);
      else fail.push(`no routine${d.days ? ` on ${JSON.stringify(d.days)}` : ""}${d.hourFrom !== undefined ? ` at ${d.hourFrom}-${d.hourTo ?? d.hourFrom}h` : ""} (new: ${newRoutines.map((r) => `${r.title} ${r.frequency} ${JSON.stringify(r.daysOfWeek)} ${r.dueTime}`).join("; ") || "none"})`);
    }
  }
  const unexpected = [
    ...created.filter((t) => !used.has(t.id)).map((t) => `task created "${t.title}"`),
    ...changed.filter((t) => !used.has(t.id)).map((t) => `task changed "${t.title}"`),
    ...gone.map((t) => `task deleted "${t.title}"`),
    ...newRoutines.filter((r) => !used.has(r.id)).map((r) => `routine created "${r.title}"`),
    ...changedRoutines.filter((r) => !used.has(r.id)).map((r) => `routine changed "${r.title}"`),
    ...(after.occ as unknown as OccRow[]).filter((o) => !usedOcc.has(o.id) && JSON.stringify(o) !== JSON.stringify((before.occ as unknown as OccRow[]).find((x) => x.id === o.id))).map(() => "routine occurrence changed"),
    ...(JSON.stringify(before.settings) !== JSON.stringify(after.settings) ? ["settings changed"] : []),
  ];
  return [...fail, ...unexpected.map((u) => `unexpected: ${u}`)];
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

const results: Array<{ id: string; group: string; text: string; expected: string; got: string; ok: boolean; e2e: boolean; missing: string[]; offered: boolean; intent: string; harm: string[]; reply: string }> = [];
for (const row of file.commands) {
  if (AI === "off") setAi(new AiService([]));
  else setAi(null);
  const user = await prisma.user.create({ data: { firebaseUid: `eval-${crypto.randomUUID()}`, email: `eval-${crypto.randomUUID()}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ, tier: "PRO" } });
  try {
    await seedUser(user.id);
    const before = await snapshot(user.id);
    const out = (await handleAssistantMessage({ user, settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, channel: "APP", now: NOW, text: row.text, payload: null, label: null })).message as { content: string; intent?: string; command?: string; cards?: unknown[]; actions?: Array<{ payload?: { type?: string; command?: string } }> };
    const after = await snapshot(user.id);
    const intent = out.intent ?? "";
    // A "Did you mean this?" with one command button (the guards' preview): scored by that command, counted as offered.
    const offered = intent === "meaning_ask" ? (out.actions ?? []).filter((a) => a.payload?.type === "command").map((a) => a.payload?.command as string) : [];
    // Every reply says which command handled it (handlers.ts → handleIntent); none = a reply only (chat, help to ask…).
    const got = offered.length === 1 ? offered[0] : (out.command ?? "none");
    // A row labelled with a reply, not a command ("support"): the reply's intent is compared instead.
    const label = (c: string) => (c === "none" || c === "multi" || getCommand(c) ? got === c : intent === c);
    const ok = label(row.command) || (row.alsoOk ?? []).some(label);
    const failed = checkRow(checks.get(row.id), out, intent, before, after);
    // End to end: the right command, an outcome (not "not found" / "which one?" / "not scheduled"), and the expected answer.
    // A clarifying question is accepted only where the row allows it (then routing is not required to be a list).
    const clarified = intent === "query_range_ask" && Boolean(checks.get(row.id)?.clarifyOk);
    const e2e = (ok || clarified) && !offered.length && !WRONG_OUTCOME.has(intent) && failed.length === 0;
    const missing = failed;
    results.push({ id: row.id, group: row.group ?? "dev", text: row.text, expected: row.command, got, ok, e2e, missing, offered: offered.length === 1, intent, harm: harmfulChanges(before, after), reply: out.content.slice(0, 140) });
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
}

const groups = [...new Set(results.map((r) => r.group))];
for (const g of groups) {
  const rs = results.filter((r) => r.group === g);
  const none = rs.filter((r) => r.expected === "none");
  const outcome = rs.filter((r) => r.ok && WRONG_OUTCOME.has(r.intent)).length;
  const checked = rs.filter((r) => r.ok && r.missing.length).length;
  console.log(`${g}: routing accuracy ${rs.filter((r) => r.ok).length}/${rs.length}; end to end ${rs.filter((r) => r.e2e).length}/${rs.length} (right command, wrong outcome ${outcome}; checks failed ${checked}; offered for a tap ${rs.filter((r) => r.ok && r.offered).length}); harmful actions on "none" rows: ${none.filter((r) => r.harm.length).length}/${none.length}${none.some((r) => r.harm.length) ? ` (${none.filter((r) => r.harm.length).map((r) => `${r.id}: ${r.harm.join(", ")}`).join("; ")})` : ""}; wrong changes on any row: ${rs.filter((r) => r.harm.length && !r.ok).length}/${rs.length}`);
}
if (arg("out")) writeFileSync(arg("out") as string, `${JSON.stringify({ file: arg("file"), ai: AI, flags: { CHAT_FIXES_V2: process.env.CHAT_FIXES_V2 ?? "off" }, results }, null, 1)}\n`);
await prisma.$disconnect();
process.exit(0);
