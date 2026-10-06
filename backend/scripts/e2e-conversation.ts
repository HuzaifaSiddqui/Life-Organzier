import "dotenv/config";
import { prisma } from "../src/config/db.js";
import { handleAssistantMessage } from "../src/modules/assistant/dialogue.js";
import { getBriefing } from "../src/modules/assistant/briefing.js";
import { planReminders } from "../src/modules/reminders/reminderService.js";
import { getAnalytics } from "../src/modules/analytics/analyticsService.js";
import { listMemories } from "../src/modules/memory/memoryService.js";
import type { ActionPayload } from "../src/modules/assistant/types.js";

const uid = `e2e-${Date.now()}`;
const user = await prisma.user.create({ data: { firebaseUid: uid, email: `${uid}@example.invalid`, displayName: "Test Student" } });
await prisma.userSettings.create({ data: { userId: user.id, timezone: "Asia/Karachi", tier: "PRO" } });
let conversationId: string | null = null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function say(text: string | null, payload?: ActionPayload) {
  const settings = await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } });
  const t0 = Date.now();
  const r = await handleAssistantMessage({ user, settings, deviceId: "e2e", text, payload: payload ?? null, label: payload ? payload.type : null, conversationId, channel: "APP" });
  conversationId = r.conversationId;
  const m = r.message;
  console.log(`\n👤 ${text ?? JSON.stringify(payload)}\n🤖 [${m.intent}, ${Date.now() - t0}ms] ${m.content}`);
  if (m.actions?.length) console.log(`   actions: ${m.actions.map((a) => a.label).join(" | ")}`);
  for (const c of m.cards ?? []) {
    if (c.type === "task") console.log(`   card task: ${c.task.title} | ${c.task.dueTime ?? ""} | ${c.task.priority} | ${c.task.taskType} | dur ${c.task.durationMinutes} | sched ${c.task.scheduledStart?.toISOString?.() ?? c.task.scheduledStart ?? "-"}`);
    if (c.type === "draft") console.log(`   card draft: clarity ${c.clarity}% missing ${c.missing.join(",")}`);
    if (c.type === "mood_support") console.log(`   mood support: ${c.recommendation.primary?.label} / ${c.recommendation.suggestions.map((s) => s.label).join("; ")}`);
    if (c.type === "task_list") console.log(`   list ${c.title}: ${c.tasks.map((t) => t.title).join("; ")}`);
    if (c.type === "plan") console.log(`   plan: ${c.plan.blocks.map((b) => `${b.kind}:${b.title}`).join("; ")}`);
  }
  return r;
}
try {
  await say("hi");
  await say("Complete math assignment by Friday 3 PM");
  await say("make it urgent");
  await say("Study physics");
  await say("tomorrow for 2 hours");
  await say("I'm feeling overwhelmed");
  await say("yes");
  await say("Listening to Urdu ghazals really helps me when I'm stressed");
  await sleep(4000);
  await say("I'm 50% done with math assignment");
  await say("Daily meditation at 6 AM for 10 minutes");
  await say("Morning workout");
  await say("every day at 7am");
  await say("what do I have today?");
  await say("plan my day");
  await say("Assignment due yesterday");
  await say("tomorrow");
  await say("I need to do stuff");
  await say("how are you today?");
  await say("I'm stressed about my exams again");
  await say("yes");
  await say("I need to finish the physics stuff, can you move it to Thursday?");
  await say("when is my math assignment due?");
  await say("Prepare portfolio project, 6 hours, due next Friday");
  await say("break it down");
  await say("delete the physics task");
  await say("yes");
  await say("I completed the math assignment");
  const { processDocument } = await import("../src/modules/documents/documentProcessing.js");
  const st = await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } });
  const doc = await processDocument(user, st, { text: `CS301 Data Structures
Instructor: Prof. Ahmed Khan
Prerequisites: CS101
Topics:
- Arrays
- Trees
- Graphs

Lectures: MWF 10-11:30 AM, Room 301
Assignment 1 due March 30, 2027 at 3 PM.
Project submission by Friday.
Final exam next month.`, fileName: "syllabus", mimeType: "text/plain", docType: "SYLLABUS", language: "eng", autoCreate: true });
  console.log("DOC: tasks", doc.createdTasks.map((t) => t.title), "routines", doc.createdRoutines.map((r) => r.title), "review", doc.extracted.deadlines.filter((d) => !d.created).map((d) => `${d.title}(${d.confidence})`));
  await say("Study trees chapter tomorrow for 1 hour");
  await say("no");
  const settings = await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } });
  await sleep(8000);
  const b = await getBriefing(user, settings);
  console.log("\nBRIEFING:", b.greeting, "|", b.headline, "| next:", b.nextUp?.title, "| attention:", b.attention.map((a) => a.kind).join(","), "| checkin:", b.mood.checkinDue);
  const rem = await planReminders(user.id, settings);
  console.log("REMINDERS:", rem.map((r) => `${r.title} @ ${new Date(r.fireAt).toLocaleString("en-GB", { timeZone: "Asia/Karachi" })} (${r.level})`).join("\n  "));
  const a = await getAnalytics(user.id, settings.timezone, "week");
  console.log("ANALYTICS:", JSON.stringify(a.totals), a.categories.map((c) => c.category).join(","));
  console.log("MEMORIES:", (await listMemories(user.id)).map((m) => `[${m.kind} ${m.embeddingModel}] ${m.content}`).join("\n  "));
} finally {
  await prisma.user.delete({ where: { id: user.id } });
  await prisma.$disconnect();
  console.log("\n(cleaned up test user)");
}
