import assert from "node:assert/strict";
import test from "node:test";
import { Priority, RoutineFrequency, TaskType, type Task } from "@prisma/client";
import { AiService, setAi } from "../src/ai/llm.js";
import { cleanTitle, extractEntities, isVagueTitle } from "../src/modules/assistant/entities.js";
import { clarityOf, draftFromEntities, fillDraft } from "../src/modules/assistant/draft.js";
import { understand } from "../src/modules/assistant/nlu.js";
import { extractCourseInfo, extractDeadlines, extractSchedules, cleanDocumentText, dateGrounded, maskPersonalNumbers } from "../src/modules/documents/extraction.js";
import { ruleBasedMemories } from "../src/modules/memory/memoryService.js";
import { detectCrisis, detectMood, recommendForMood } from "../src/modules/mood/moodService.js";
import { findPeakWindows } from "../src/modules/patterns/patternService.js";
import { respectQuietHours, sequenceForTask } from "../src/modules/reminders/reminderService.js";
import { autoScheduleSlot, chunkPlan, suggestSlot, type ScheduleContext } from "../src/modules/scheduling/schedulingService.js";
import { computeDueAt, localParts, localYmd, parseClock, zonedTimeToUtc } from "../src/lib/time.js";
import { NOW, opts, settings, task, TZ } from "./fixtures.js";

// Deterministic tests never reach a real model.
setAi(new AiService([]));

/* ------------------------------------------------------------ time */

test("timezone conversions round-trip for Karachi", () => {
  const instant = zonedTimeToUtc("2026-10-09", 15, 0, TZ);
  assert.equal(instant.toISOString(), "2026-10-09T10:00:00.000Z");
  const p = localParts(instant, TZ);
  assert.equal(p.h, 15);
  assert.equal(localYmd(instant, TZ), "2026-10-09");
});

test("computeDueAt treats date-only deadlines as end of day and supports both date encodings", () => {
  const localMidnight = zonedTimeToUtc("2026-10-09", 0, 0, TZ);
  const utcNoon = new Date("2026-10-09T12:00:00.000Z");
  assert.equal(computeDueAt(localMidnight, "3 PM", TZ)?.toISOString(), "2026-10-09T10:00:00.000Z");
  assert.equal(computeDueAt(utcNoon, "3 PM", TZ)?.toISOString(), "2026-10-09T10:00:00.000Z");
  assert.equal(localParts(computeDueAt(localMidnight, null, TZ) as Date, TZ).h, 23);
});

test("parseClock handles common spoken formats", () => {
  assert.deepEqual(parseClock("5 PM"), { h: 17, m: 0 });
  assert.deepEqual(parseClock("5:30pm"), { h: 17, m: 30 });
  assert.deepEqual(parseClock("12 AM"), { h: 0, m: 0 });
  assert.deepEqual(parseClock("17:45"), { h: 17, m: 45 });
  assert.equal(parseClock("25:00"), null);
});

/* ------------------------------------------------------------ entities */

test("FR-TM-001: 'Complete math assignment by Friday 3 PM' is a complete deadline task", () => {
  const e = extractEntities("Complete math assignment by Friday 3 PM", opts);
  assert.equal(e.date?.ymd, "2026-10-09");
  assert.equal(e.time, "3 PM");
  assert.equal(e.category, "Academic");
  const draft = draftFromEntities("Complete math assignment by Friday 3 PM", cleanTitle(e.residual), e, "2026-10-05");
  assert.equal(draft.title, "Complete math assignment");
  assert.equal(draft.taskType, TaskType.DEADLINE);
  const { clarity, missing } = clarityOf(draft);
  assert.ok(clarity >= 95, `clarity ${clarity}`);
  assert.deepEqual(missing, []);
});

test("FR-TM-001: 'Study physics' has clarity below 30% and asks when/how long", () => {
  const e = extractEntities("Study physics", opts);
  const draft = draftFromEntities("Study physics", cleanTitle(e.residual), e, "2026-10-05");
  const { clarity, missing } = clarityOf(draft);
  assert.ok(clarity < 30, `clarity ${clarity}`);
  assert.ok(missing.includes("date"));
  assert.ok(missing.includes("duration"));
});

test("FR-TM-001: 'I need 2 hours to study this weekend' detects duration + fuzzy weekend and asks what/when", () => {
  const text = "I need 2 hours to study this weekend";
  const e = extractEntities(text, opts);
  assert.equal(e.durationMinutes, 120);
  assert.equal(e.date?.fuzzy, true);
  assert.equal(e.date?.ymd, "2026-10-10");
  const draft = draftFromEntities(text, cleanTitle(e.residual), e, "2026-10-05");
  const { missing } = clarityOf(draft);
  assert.ok(missing.includes("title"));
  assert.ok(missing.includes("date"));
});

test("slot filling: answering '3 PM' completes a deadline draft", () => {
  const text = "Add assignment due Friday";
  const e = extractEntities(text, opts);
  const draft = draftFromEntities(text, cleanTitle(e.residual), e, "2026-10-05");
  assert.deepEqual(clarityOf(draft).missing, ["time"]);
  const { draft: filled, filled: ok } = fillDraft(draft, ["time"], "3 PM", opts);
  assert.ok(ok);
  assert.equal(filled.dueTime, "3 PM");
  assert.ok(clarityOf(filled).clarity >= 95);
});

test("relative times, explicit dates and time ranges", () => {
  assert.equal(extractEntities("call mom in 2 hours", opts).time, "12 PM");
  assert.equal(extractEntities("Assignment 1 due March 30, 2027 at 3 PM", opts).date?.ymd, "2027-03-30");
  assert.equal(extractEntities("submit on 3/30/27", opts).date?.ymd, "2027-03-30");
  const r = extractEntities("Linear Algebra MWF 10-11:30 AM Room 301", opts);
  assert.deepEqual(r.daysOfWeek, [1, 3, 5]);
  assert.equal(r.time, "10 AM");
  assert.equal(r.durationMinutes, 90);
  assert.equal(extractEntities("Assignment due yesterday", opts).date?.past, true);
});

test("routine frequency extraction", () => {
  const daily = extractEntities("Daily meditation at 6 AM for 10 minutes", opts);
  assert.equal(daily.frequency, RoutineFrequency.DAILY);
  assert.equal(daily.time, "6 AM");
  assert.equal(daily.durationMinutes, 10);
  const weekly = extractEntities("gym every Tue & Thu at 7pm", opts);
  assert.equal(weekly.frequency, RoutineFrequency.WEEKLY);
  assert.deepEqual(weekly.daysOfWeek, [2, 4]);
  assert.equal(extractEntities("Mandatory daily prayer at 5 AM", opts).routinePriority, "MANDATORY");
});

test("vague titles", () => {
  assert.equal(isVagueTitle("Do stuff"), true);
  assert.equal(isVagueTitle("Study"), true);
  assert.equal(isVagueTitle("Study physics"), false);
});

/* ------------------------------------------------------------ intent rules (no LLM) */

async function intentOf(text: string) {
  return understand(text, { ...opts, history: [], allowLlm: false });
}

test("intent rules cover the FRD conversational commands", async () => {
  assert.equal((await intentOf("Move assignment to Monday")).intent, "update_task");
  assert.equal((await intentOf("Make this urgent")).intent, "update_task");
  assert.equal((await intentOf("I'm 75% done with essay")).intent, "set_progress");
  assert.equal((await intentOf("How much is assignment done?")).intent, "query_progress");
  assert.equal((await intentOf("Split exam study into Chapter 1, 2, 3")).intent, "split_task");
  assert.deepEqual((await intentOf("Split exam study into Chapter 1, 2, 3")).splitParts, ["Chapter 1", "Chapter 2", "Chapter 3"]);
  assert.equal((await intentOf("I completed homework")).intent, "complete_task");
  assert.equal((await intentOf("Remove homework from list")).intent, "delete_task");
  assert.equal((await intentOf("What do I have today?")).intent, "query_tasks");
  assert.equal((await intentOf("I'm feeling overwhelmed")).intent, "log_mood");
  assert.equal((await intentOf("Daily meditation at 6 AM for 10 minutes")).intent, "create_routine");
  assert.equal((await intentOf("Complete math assignment by Friday 3 PM")).intent, "create_task");
  assert.equal((await intentOf("plan my day")).intent, "plan_day");
  assert.equal((await intentOf("I prefer studying at night")).intent, "provide_info");
  assert.equal((await intentOf("yes")).intent, "confirm");
  assert.equal((await intentOf("undo")).intent, "undo");
  assert.equal((await intentOf("I'm at work now")).intent, "switch_context");
});

/* ------------------------------------------------------------ mood & safety */

test("mood detection with confidence and negation", () => {
  assert.equal(detectMood("I'm feeling overwhelmed")?.mood, "overwhelmed");
  assert.ok((detectMood("This assignment is making me anxious")?.confidence ?? 0) >= 0.8);
  assert.equal(detectMood("I'm not stressed at all"), null);
  assert.equal(detectCrisis("sometimes I want to end my life"), true);
  assert.equal(detectCrisis("I want to end this meeting early"), false);
});

test("FR-MH-002: stressed users get light tasks, never long study blocks", () => {
  const tasks = [
    task({ id: "big", title: "Study 4 hours", durationMinutes: 240, difficulty: 5, priority: Priority.HIGH }),
    task({ id: "small", title: "Reply to email", durationMinutes: 10, difficulty: 1 }),
  ];
  const rec = recommendForMood("stressed", tasks, ["User listens to Urdu ghazals when stressed"]);
  assert.equal(rec.primary?.action.type, "breathing");
  const labels = rec.suggestions.map((s) => s.label).join(" | ");
  assert.ok(!labels.includes("Study 4 hours"));
  assert.ok(labels.includes("Urdu ghazals"));
  const happy = recommendForMood("happy", tasks, []);
  assert.equal(happy.primary?.label, "Study 4 hours");
});

/* ------------------------------------------------------------ memory */

test("rule-based memory extraction learns preferences and coping strategies", () => {
  const m = ruleBasedMemories("Listening to music really helps me when exams get hard. I work best in the morning.");
  assert.ok(m.some((x) => x.kind === "COPING" && /music/i.test(x.content)));
  assert.ok(m.some((x) => x.kind === "PREFERENCE" && /morning/i.test(x.content)));
  assert.deepEqual(ruleBasedMemories("Submit the report by Friday"), []);
});

/* ------------------------------------------------------------ patterns & scheduling */

test("peak window detection groups contiguous productive hours", () => {
  const hist = new Array<number>(24).fill(0);
  [9, 10, 11].forEach((h) => (hist[h] = 10));
  [15, 16].forEach((h) => (hist[h] = 8));
  hist[20] = 1;
  const { windows, share } = findPeakWindows(hist);
  assert.deepEqual(windows, [{ start: 9, end: 12 }, { start: 15, end: 17 }]);
  assert.ok(share > 0.9);
});

function scheduleCtx(tasks: Task[] = [], s = settings()): ScheduleContext {
  return { tz: TZ, settings: s, tasks, occurrences: [], peak: { windows: [{ start: 9, end: 12 }, { start: 15, end: 17 }], learned: true, confidence: 0.9 } };
}

test("auto-schedule: a DEADLINE task with a duration gets a work block that ends before the deadline", () => {
  const draft = { taskType: TaskType.DEADLINE, durationMinutes: 180, priority: Priority.MEDIUM, difficulty: null, dueYmd: "2026-10-09" };
  const deadline = zonedTimeToUtc("2026-10-09", 15, 0, TZ); // Friday 3 PM
  const { slot, attempted } = autoScheduleSlot(scheduleCtx(), draft, deadline, NOW);
  assert.equal(attempted, true);
  assert.ok(slot && slot.end <= deadline);
});

test("auto-schedule: no slot before the deadline → nothing is booked", () => {
  const draft = { taskType: TaskType.DEADLINE, durationMinutes: 180, priority: Priority.MEDIUM, difficulty: null, dueYmd: "2026-10-05" };
  const deadline = zonedTimeToUtc("2026-10-05", 11, 0, TZ); // due in 1 hour, needs 3
  assert.deepEqual(autoScheduleSlot(scheduleCtx(), draft, deadline, NOW), { slot: null, attempted: true });
});

test("auto-schedule: only duration work is placed; FIXED and duration-less tasks are left alone", () => {
  const base = { durationMinutes: 60, priority: Priority.MEDIUM, difficulty: null, dueYmd: null };
  assert.deepEqual(autoScheduleSlot(scheduleCtx(), { ...base, taskType: TaskType.FIXED }, null, NOW), { slot: null, attempted: false });
  assert.deepEqual(autoScheduleSlot(scheduleCtx(), { ...base, taskType: TaskType.DEADLINE, durationMinutes: null }, null, NOW), { slot: null, attempted: false });
  assert.ok(autoScheduleSlot(scheduleCtx(), { ...base, taskType: TaskType.FLEXIBLE }, null, NOW).slot);
  assert.ok(autoScheduleSlot(scheduleCtx(), { ...base, taskType: TaskType.DURATION }, null, NOW).slot);
});

test("FR-TM-006: a hard 3-hour task lands in the next peak window", () => {
  const slot = suggestSlot(scheduleCtx(), { durationMinutes: 180, priority: Priority.MEDIUM, difficulty: 4 }, NOW);
  assert.ok(slot);
  const p = localParts(slot.start, TZ);
  assert.equal(p.h, 9);
  assert.equal(slot.ymd, "2026-10-06");
  assert.ok(slot.inPeak);
  assert.match(slot.reason, /most productive/);
});

test("FR-TM-006: overloaded days are skipped and busy blocks avoided", () => {
  const busy = task({
    id: "busy",
    taskType: TaskType.FLEXIBLE,
    scheduledStart: zonedTimeToUtc("2026-10-06", 8, 0, TZ),
    scheduledEnd: zonedTimeToUtc("2026-10-06", 17, 0, TZ),
  });
  const slot = suggestSlot(scheduleCtx([busy]), { durationMinutes: 120, priority: Priority.MEDIUM, difficulty: 4, earliest: zonedTimeToUtc("2026-10-06", 0, 0, TZ) }, NOW);
  assert.ok(slot);
  assert.notEqual(slot.ymd, "2026-10-06");
});

test("FR-MH-003: chunk plan alternates 45-min focus and 15-min breaks", () => {
  const plan = chunkPlan(zonedTimeToUtc("2026-10-05", 15, 0, TZ), 180);
  assert.deepEqual(plan.map((b) => b.kind), ["work", "break", "work", "break", "work", "break", "work"]);
  assert.equal(localParts(plan[1].start, TZ).mi, 45);
});

/* ------------------------------------------------------------ reminders */

test("FR-RN-001: escalating sequence for a Friday 11:59 PM deadline", () => {
  const dueAt = zonedTimeToUtc("2026-10-09", 23, 59, TZ);
  const drafts = sequenceForTask(task({ dueAt, durationMinutes: 120 }), settings(), TZ, 9, undefined, NOW);
  const labels = drafts.map((d) => `${localYmd(d.at, TZ)} ${localParts(d.at, TZ).h}:${String(localParts(d.at, TZ).mi).padStart(2, "0")} ${d.level}`);
  assert.deepEqual(labels, [
    "2026-10-06 14:00 gentle",
    "2026-10-07 9:00 normal",
    "2026-10-08 10:00 urgent",
    "2026-10-09 9:00 critical",
    "2026-10-09 22:59 urgent",
  ]);
});

test("FR-RN-001 §6: reminders inside quiet hours move to the morning", () => {
  const at = zonedTimeToUtc("2026-10-07", 2, 0, TZ);
  const moved = respectQuietHours(at, zonedTimeToUtc("2026-10-09", 23, 59, TZ), settings(), TZ);
  assert.equal(localParts(moved, TZ).h, 8);
  // If the morning is after the deadline, use the previous evening.
  const early = respectQuietHours(at, zonedTimeToUtc("2026-10-07", 6, 0, TZ), settings(), TZ);
  assert.equal(localParts(early, TZ).h, 21);
});

test("minimal frequency produces a single critical reminder", () => {
  const dueAt = zonedTimeToUtc("2026-10-09", 23, 59, TZ);
  const drafts = sequenceForTask(task({ dueAt }), settings({ notificationFrequency: "MINIMAL" }), TZ, 9, undefined, NOW);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].level, "critical");
});

test("a timed task always gets a reminder at its time, even at short notice", () => {
  // Due 20 minutes from NOW: every earlier nudge is already in the past.
  const dueAt = new Date(NOW.getTime() + 20 * 60000);
  const drafts = sequenceForTask(task({ dueAt, dueTime: "10:20 AM" }), settings(), TZ, 9, undefined, NOW);
  const onTime = drafts.filter((d) => d.at.getTime() === dueAt.getTime());
  assert.equal(onTime.length, 1);
  assert.equal(onTime[0].level, "critical");
});

/* ------------------------------------------------------------ documents */

const SYLLABUS = `CS301 Data Structures
Instructor: Prof. Ahmed Khan
Prerequisites: CS101
Topics:
- Arrays
- Linked Lists
- Trees
- Graphs
- Sorting

Grading: 30% Assignments, 20% Midterm, 20% Project, 30% Final
Lectures: MWF 10-11:30 AM, Room 301
Assignment 1 due March 30, 2027 at 3 PM.
Project submission by Friday.
Final exam next month.
Page 1 of 3`;

test("FR-DP-002: deadline confidence follows the FRD thresholds", () => {
  const deadlines = extractDeadlines(cleanDocumentText(SYLLABUS), NOW, TZ);
  const a1 = deadlines.find((d) => /assignment 1/i.test(d.title));
  assert.ok(a1 && a1.confidence >= 95, JSON.stringify(a1));
  assert.equal(a1?.date, "2027-03-30");
  const project = deadlines.find((d) => /project/i.test(d.title));
  assert.ok(project && project.assumedTime && project.time === "11:59 PM" && project.confidence < 95);
  const final = deadlines.find((d) => /final/i.test(d.title));
  assert.ok(final && final.date === null && final.confidence < 80, JSON.stringify(final));
});

test("FR-DP-003/004: schedules and course info are extracted", () => {
  const schedules = extractSchedules(cleanDocumentText(SYLLABUS), NOW, TZ);
  const lecture = schedules.find((s) => s.daysOfWeek.length === 3);
  assert.ok(lecture, JSON.stringify(schedules));
  assert.deepEqual(lecture?.daysOfWeek, [1, 3, 5]);
  assert.equal(lecture?.room, "301");
  assert.ok((lecture?.confidence ?? 0) >= 90);
  const course = extractCourseInfo(SYLLABUS);
  assert.equal(course.code, "CS301");
  assert.equal(course.instructor, "Ahmed Khan");
  assert.deepEqual(course.prerequisites, ["CS101"]);
  assert.ok(course.topics.includes("Trees"));
  assert.ok(course.grading.some((g) => /final/i.test(g.item) && g.weight === 30));
});

test("timetable rows produce one schedule per cell", () => {
  const schedules = extractSchedules("Monday | 9:00-10:30 AM Calculus | 11:00 AM-12:30 PM Physics", NOW, TZ);
  assert.equal(schedules.length, 2);
  assert.deepEqual(schedules.map((s) => s.daysOfWeek[0]), [1, 1]);
});

test("AI document items: a date only survives if the document actually contains it", () => {
  assert.equal(dateGrounded("2026-09-07", "Departure Date: 07-09-2026 00:30"), true);
  assert.equal(dateGrounded("2026-10-18", "Due Date: 18 Oct 2026."), true);
  assert.equal(dateGrounded("2026-10-15", "RSVP by 15 October"), true);
  assert.equal(dateGrounded("2026-10-24", "Saturday 24th October 2026"), true);
  assert.equal(dateGrounded("2026-10-07", "Total Rs 620. 06/10/2026"), false);
  assert.equal(dateGrounded("2026-11-05", "Train ticket, seat 15B"), false);
});

test("documents: national ID and phone numbers are masked, dates and times are not", () => {
  const ticket = "Departure Date: 07-09-2026 00:30\nPhone/099: 03104630682\nID No. (CNIC)3840530587473\nAlt: 38405-3058747-3, +92 310 4630682\nFare: Rs.1200.00";
  const out = maskPersonalNumbers(ticket);
  assert.ok(!/3840530587473|38405-3058747-3|03104630682|310 4630682/.test(out), out);
  assert.match(out, /07-09-2026 00:30/);
  assert.match(out, /Rs\.1200\.00/);
  assert.equal((out.match(/\[CNIC\]/g) ?? []).length, 2);
  assert.equal((out.match(/\[PHONE\]/g) ?? []).length, 2);
});
