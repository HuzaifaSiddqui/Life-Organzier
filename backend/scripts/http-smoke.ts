/**
 * HTTP integration smoke test: runs the real Express app with Firebase token verification stubbed
 * to a temporary database-only user (no Firebase account is created), exercises every route,
 * then deletes the user. Usage: npm run smoke
 */
import "dotenv/config";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import admin from "firebase-admin";
import { createApp } from "../src/app.js";
import { initFirebase } from "../src/config/firebase.js";
import { prisma } from "../src/config/db.js";

initFirebase();
const uid = `smoke-${Date.now()}`;
const email = `${uid}@example.invalid`;
const authInstance = admin.auth() as unknown as { verifyIdToken: (t: string) => Promise<unknown> };
authInstance.verifyIdToken = async () => ({ uid, email, name: "Smoke Tester" });

const server = createApp().listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
const headers = { Authorization: "Bearer test", "Content-Type": "application/json", "X-Timezone": "Asia/Karachi", "X-Device-Id": "smoke" };
let failures = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, body?: unknown, expect = 200): Promise<any> {
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (await res.json().catch(() => ({}))) as { data?: any; message?: string };
  const ok = res.status === expect;
  if (!ok) failures += 1;
  console.log(`${ok ? "✓" : "✗"} ${method} ${path} → ${res.status}${ok ? "" : ` (expected ${expect}) ${json.message ?? ""}`}`);
  return json.data;
}

try {
  await call("POST", "/auth/sync-user");
  await call("GET", "/users/me");
  await call("GET", "/settings");
  await call("PUT", "/settings", { quietStart: "10 PM", quietEnd: "8:00 AM", contexts: ["At Home", "At Work"], currentContext: "At Home", tier: "PRO" });
  await call("POST", "/settings/dnd", { minutes: 120 });
  await call("POST", "/settings/dnd", { minutes: 0 });
  await call("GET", "/categories");
  await call("POST", "/categories", { name: "Traveling", color: "#2563EB" }, 201);
  await call("POST", "/categories", { name: "Work", color: "#2563EB" }, 409);

  const t = (
    await call(
      "POST",
      "/tasks",
      { title: "Smoke task", priority: "HIGH", source: "MANUAL", dueDate: new Date(Date.now() + 2 * 86400000).toISOString(), dueTime: "3 PM", durationMinutes: 120, tags: ["Exam", "study"] },
      201,
    )
  ).task;
  assert.ok(t.dueAt, "dueAt computed");
  await call("GET", "/tasks");
  await call("GET", `/tasks/${t.id}`);
  await call("PUT", `/tasks/${t.id}`, { priority: "URGENT" });
  await call("POST", `/tasks/${t.id}/undo`);
  await call("PATCH", `/tasks/${t.id}/progress`, { progress: 50 });
  await call("GET", `/tasks/${t.id}/suggest-slot`);
  await call("POST", `/tasks/${t.id}/split`, { parts: [{ title: "Part A" }, { title: "Part B" }] });
  await call("POST", "/tasks/suggest", { text: "Study for calculus exam" });
  await call("GET", "/tags");
  await call("DELETE", `/tasks/${t.id}`);
  await call("GET", "/tasks/deleted");
  await call("POST", `/tasks/${t.id}/restore`);
  await call("POST", "/tasks", { title: "", priority: "LOW", source: "MANUAL" }, 400);

  // Offline sync: idempotent create + concurrent edits merged field by field
  const sync1 = await call("POST", "/sync", {
    mutations: [{ mutationId: "m1", op: "create", localId: "local-1", changes: { title: "Offline task", priority: "MEDIUM" }, clientModifiedAt: new Date().toISOString() }],
    since: null,
  });
  const created = sync1.results[0].task;
  const again = await call("POST", "/sync", {
    mutations: [{ mutationId: "m1b", op: "create", localId: "local-1", changes: { title: "Offline task", priority: "MEDIUM" }, clientModifiedAt: new Date().toISOString() }],
    since: sync1.serverTime,
  });
  assert.equal(again.results[0].task.id, created.id, "no duplicate on retried create");
  await call("PUT", `/tasks/${created.id}`, { description: "changed on device B" });
  const merged = await call("POST", "/sync", {
    mutations: [{ mutationId: "m2", op: "update", taskId: created.id, baseVersion: 1, changes: { title: "Renamed on device A" }, clientModifiedAt: new Date().toISOString() }],
    since: null,
  });
  const final = merged.results[0].task;
  assert.equal(final.title, "Renamed on device A");
  assert.equal(final.description, "changed on device B", "field-level merge keeps both changes");
  console.log("   sync: idempotent create + field-level merge verified");

  const routine = (await call("POST", "/routines", { title: "Prayer", frequency: "DAILY", dueTime: "5 AM", priority: "MANDATORY", timeLocked: true }, 201)).routine;
  await call("GET", "/routines/today");
  await call("GET", "/routines?all=true");
  const occ = await prisma.routineOccurrence.findFirst({ where: { routineId: routine.id, status: "PENDING" }, orderBy: { occurrenceDate: "desc" } });
  assert.ok(occ, "occurrences generated");
  await call("PATCH", `/routines/occurrences/${occ.id}`, { status: "SKIPPED" }, 409);
  await call("PATCH", `/routines/occurrences/${occ.id}`, { status: "SKIPPED", confirmMandatory: true });
  await call("PUT", `/routines/${routine.id}`, { dueTime: "5:30 AM" });

  await call("POST", "/mood", { mood: "stressed", score: 3, source: "CHECKIN" }, 201);
  await call("GET", "/mood");
  await call("POST", "/memory", { content: "I focus best before noon", kind: "PREFERENCE" }, 201);
  const mem = await call("GET", "/memory");
  assert.ok(mem.memories.length >= 1);
  await call("GET", "/insights");
  await call("GET", "/reminders/plan");
  await call("POST", "/reminders/action", { taskId: t.id, action: "SNOOZE" });
  await call("GET", "/scheduling/day");
  await call("POST", "/scheduling/suggest", { durationMinutes: 90, priority: "HIGH" });
  for (const r of ["week", "month", "3months", "all"]) await call("GET", `/analytics?range=${r}`);
  await call("GET", "/analytics/export");
  await call("GET", "/account/export");
  await call("POST", "/events", { type: "APP_OPEN" });

  const brief = await call("GET", "/assistant/briefing");
  assert.ok(brief.briefing.greeting);
  const reply = await call("POST", "/assistant/message", { text: "Remind me to call Ali tomorrow at 5 PM" });
  console.log("   assistant:", reply.message.content.replace(/\n/g, " | "));
  await call("POST", "/assistant/message", { payload: { type: "plan_day" }, label: "Plan my day" });
  await call("GET", "/assistant/conversations/current");
  await call("POST", "/assistant/message", {}, 400);

  const doc = await call(
    "POST",
    "/documents/text",
    { text: "CS301 Data Structures\nPrerequisites: CS101\nAssignment 1 due March 30, 2027 at 3 PM.\nLectures: MWF 10-11:30 AM, Room 301", docType: "SYLLABUS" },
    201,
  );
  console.log(`   document: auto-created ${doc.createdTasks.length} task(s), ${doc.createdRoutines.length} routine(s)`);
  const form = new FormData();
  form.append("file", new Blob(["Quiz 2 due 2027-04-12 at 9 AM"], { type: "text/plain" }), "quiz.txt");
  form.append("docType", "OTHER");
  const up = await fetch(`${base}/documents`, { method: "POST", headers: { Authorization: "Bearer test", "X-Timezone": "Asia/Karachi" }, body: form });
  console.log(`${up.status === 201 ? "✓" : "✗"} POST /documents (multipart) → ${up.status}`);
  if (up.status !== 201) failures += 1;
  await call("GET", "/documents");

  await call("POST", "/account/delete");
  await call("POST", "/account/recover");
} catch (error) {
  failures += 1;
  console.error("✗ assertion failed:", error);
} finally {
  await prisma.user.deleteMany({ where: { firebaseUid: uid } });
  server.close();
  await prisma.$disconnect();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL HTTP CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}
