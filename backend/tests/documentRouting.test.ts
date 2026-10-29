import assert from "node:assert/strict";
import test from "node:test";
import { Priority } from "@prisma/client";
import { AiService, setAi } from "../src/ai/llm.js";
import { analyzeDocument, DEADLINE_AUTO } from "../src/modules/documents/documentProcessing.js";
import { extractDeadlines, type ExtractedDeadline, type ExtractedSchedule } from "../src/modules/documents/extraction.js";
import { layoutRows } from "../src/modules/documents/gridTimetable.js";
import { AGREE_MAX, agreeOnAiItems, documentPriority, itemsFromPickedLines, kindByRules, routeItems, verifyEvidence } from "../src/modules/documents/routing.js";
import { NOW, TZ } from "./fixtures.js";

const d = (o: Partial<ExtractedDeadline>): ExtractedDeadline => ({ index: 0, title: "X", activity: "deadline", date: "2026-11-01", time: null, assumedTime: false, confidence: 96, source: "", ...o });
const s = (o: Partial<ExtractedSchedule>): ExtractedSchedule => ({ index: 0, title: "Physics", frequency: null, daysOfWeek: [1], time: "9:00 AM", durationMinutes: 60, room: null, instructor: null, confidence: 92, source: "", ...o });
const kind = (text: string) => kindByRules(text, { deadlines: extractDeadlines(text, NOW, TZ), schedules: [], grid: false });

test.afterEach(() => setAi(new AiService([])));

function withFlags<T>(flags: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const keep = Object.fromEntries(Object.keys(flags).map((k) => [k, process.env[k]]));
  Object.assign(process.env, flags);
  return run().finally(() => {
    for (const [k, v] of Object.entries(keep)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
}

test("DOC_ROUTING type rules: date sheet, assignment, notice, other; timetable from the readers", () => {
  assert.equal(kind("Final Examination Date Sheet\nOperating Systems 3 November 2026\nDatabases 5 November 2026\nNetworks 7 November 2026").kind, "schedule");
  assert.deepEqual(kind("Assignment 2: Linked lists\nSubmission deadline: 12 November 2026 11:59 PM"), { kind: "assignment", confidence: 0.85, via: "rules" });
  assert.equal(kind("NOTICE\nThe convocation will be held on 20 November 2026 in the main hall.").kind, "notice");
  assert.equal(kind("Lecture notes on recursion and stacks, with examples").kind, "other");
  const t = kindByRules("Mon Tue Wed", { deadlines: [], schedules: [s({}), s({ title: "Maths" }), s({ title: "Chem" })], grid: false });
  assert.equal(t.kind, "timetable");
  assert.ok(kind("Meet Sara 3 Nov 2026 and 9 Nov 2026").confidence < 0.75, "no type word: unsure, the model may be asked");
});

test("DOC_ROUTING: each type creates only its own kind of item; the rest goes to review", () => {
  const items = [d({ title: "Convocation", confidence: 96 }), d({ title: "Rehearsal", date: "2026-11-18", confidence: 97 })];
  const notice = routeItems("notice", items, [s({})]);
  assert.equal(notice.deadlines.filter((x) => x.confidence >= DEADLINE_AUTO).length, 1, "a notice is one task");
  assert.ok(notice.schedules.every((x) => x.confidence < 90));
  const other = routeItems("other", items, [s({})]);
  assert.ok(other.deadlines.every((x) => x.review && x.confidence < DEADLINE_AUTO) && other.schedules.every((x) => x.confidence < 90), "other: nothing automatic");
  const timetable = routeItems("timetable", items, [s({})]);
  assert.equal(timetable.schedules[0].confidence, 92);
  assert.ok(timetable.deadlines.every((x) => x.confidence < DEADLINE_AUTO));
});

test("DOC_PRIORITY_V2: item type, days left and weightage", () => {
  const today = "2026-10-05";
  assert.equal(documentPriority({ title: "Final Exam: Databases", activity: "exam", date: "2026-10-07", source: "Final exam (40%) 7 Oct" }, today).priority, Priority.URGENT);
  assert.equal(documentPriority({ title: "Midterm", activity: "exam", date: "2026-10-15", source: "" }, today).priority, Priority.HIGH);
  assert.equal(documentPriority({ title: "Assignment 3", activity: "assignment", date: "2026-10-10", source: "" }, today).priority, Priority.MEDIUM);
  assert.equal(documentPriority({ title: "Quiz 4", activity: "quiz", date: "2026-11-20", source: "" }, today).priority, Priority.LOW);
  assert.equal(documentPriority({ title: "Project report", activity: "deadline", date: "2026-11-20", source: "" }, today, [{ item: "Project", weight: 30 }]).priority, Priority.HIGH, "weight from the course's grading table");
});

test("DOC_EVIDENCE: the line must be in the text and give the date (and time)", () => {
  const text = "Course outline\nQuiz 2 on 14 November 2026 at 10:00 AM\nProject due 1 December 2026";
  assert.equal(verifyEvidence(d({ date: "2026-11-14", time: "10:00 AM", source: "Quiz 2 on 14 November 2026 at 10:00 AM" }), text).verified, true);
  assert.equal(verifyEvidence(d({ date: "2026-11-14", source: "Quiz 2 on 14 Novembr 2026 at 10:00 AM" }), text).verified, true, "an OCR slip still matches (≥ 0.9)");
  const invented = verifyEvidence(d({ date: "2026-11-14", source: "Lab test on 14 November 2026" }), text);
  assert.equal(invented.verified, false);
  assert.ok(invented.review && invented.confidence < DEADLINE_AUTO);
  assert.equal(verifyEvidence(d({ date: "2026-11-15", source: "Quiz 2 on 14 November 2026 at 10:00 AM" }), text).verified, false, "the line doesn't give that date");
  assert.equal(verifyEvidence(d({ date: "2026-11-14", time: "3:00 PM", source: "Quiz 2 on 14 November 2026 at 10:00 AM" }), text).verified, false, "nor that time");
});

test("DOC_EVIDENCE end to end: an unverified AI item adds no agreement bonus, so it can't push an item over the gate", async () => {
  // The rules read this ticket line as a reviewed item (90); a verified model reading would raise it, an invented one must not.
  setAi(new AiService([{ name: "fake", chat: async () => JSON.stringify({ items: [{ kind: "travel", title: "Train 1-UP departure", date: "2026-11-07", time: "", evidence: "made-up line about a train" }] }) }]));
  const text = "Pakistan Railways e-ticket\nTrain 1-UP Karachi to Lahore\nDeparture: 7 November 2026 06:30 AM";
  const on = await withFlags({ DOC_EVIDENCE: "on" }, () => analyzeDocument({ text, fileName: "t.txt", mimeType: "text/plain", docType: "OTHER", language: "eng", tz: TZ, now: NOW }));
  assert.ok(on.deadlines.every((x) => !x.aiAgrees), "no agreement from an unverified reading");
  assert.ok(on.deadlines.every((x) => x.confidence < DEADLINE_AUTO));
});

test("DOC_FALLBACK_UI pick lines: only lines of the document; dated or undated, always review", () => {
  const text = "Society meeting notes\nSubmit the budget by 20 November 2026\nBook the hall";
  const read = (line: string) => extractDeadlines(line, NOW, TZ);
  assert.equal(itemsFromPickedLines(["Something I typed"], text, read), null);
  const items = itemsFromPickedLines(["Submit the budget by 20 November 2026", "Book the hall"], text, read)!;
  assert.equal(items.length, 2);
  assert.equal(items[0].date, "2026-11-20");
  assert.equal(items[1].date, null);
  assert.ok(items.every((x) => x.review && x.confidence < DEADLINE_AUTO));
});

test("DOC_AGREE: AI-only items both models found gain confidence but stay below the gate; rules items unchanged", async () => {
  const rules = d({ title: "Midterm", confidence: 96 });
  const both = d({ title: "Return library book", date: "2026-11-20", confidence: 80, aiOnly: true });
  const one = d({ title: "Pay fee", date: "2026-11-25", confidence: 80, aiOnly: true });
  const r = await agreeOnAiItems([rules, both, one], async () => [d({ title: "Library book return", date: "2026-11-20" })]);
  assert.deepEqual(r.deadlines.map((x) => x.confidence), [96, AGREE_MAX, 80]);
  assert.ok(AGREE_MAX < DEADLINE_AUTO);
  assert.equal((r.deadlines[1] as { modelsAgree?: boolean }).modelsAgree, true);
  assert.deepEqual((await agreeOnAiItems([both], async () => { throw new Error("second model down"); })).deadlines, [both]);
});

test("DOC_LAYOUT: word boxes become rows and columns; a page that isn't a table gives null", () => {
  const w = (text: string, x: number, y: number) => ({ text, conf: 90, x0: x, y0: y, x1: x + text.length * 10, y1: y + 20, line: y });
  const words = [w("Paper", 0, 0), w("Date", 300, 0), w("Databases", 0, 40), w("3-Nov-2026", 300, 42), w("Networks", 0, 80), w("5-Nov-2026", 300, 78), w("Compilers", 0, 120), w("7-Nov-2026", 300, 121)];
  assert.equal(layoutRows(words), "Paper | Date\nDatabases | 3-Nov-2026\nNetworks | 5-Nov-2026\nCompilers | 7-Nov-2026");
  assert.equal(layoutRows([w("Dear", 0, 0), w("student,", 60, 0), w("welcome", 0, 40)]), null);
});

test("flags off: no type, no text view fields, the old priority rule", async () => {
  const a = await analyzeDocument({ text: "Assignment 2 due 12 November 2026", fileName: "a.txt", mimeType: "text/plain", docType: "OTHER", language: "eng", tz: TZ, now: NOW });
  assert.equal(a.kind, undefined);
});
