import assert from "node:assert/strict";
import test from "node:test";
import { capOcrConfidence, DEADLINE_AUTO } from "../src/modules/documents/documentProcessing.js";
import { documentYear, isHeaderRow, joinRecords, normalizeDocumentText, rangeToEnd, readTables, repairOcr, semesterStart, urduWeekdayStart, weekToDate } from "../src/modules/documents/dateRules.js";
import { extractDeadlines, extractSchedules } from "../src/modules/documents/extraction.js";
import { NOW, TZ } from "./fixtures.js";

test("OCR repair only inside date-like tokens", () => {
  assert.equal(repairOcr("Assignment 2 due 0ct 12, 2026"), "Assignment 2 due Oct 12, 2026");
  assert.equal(repairOcr("Quiz 4 on l2 Nov 2026"), "Quiz 4 on 12 Nov 2026");
  assert.equal(repairOcr("Final Exam: 2O Dec 2026"), "Final Exam: 20 Dec 2026");
  assert.equal(repairOcr("due Decernber 10, 2026 by 1 1: 59 PM"), "due December 10, 2026 by 11:59 PM");
  assert.equal(repairOcr("Assignrnent 1"), "Assignment 1");
  for (const keep of ["I may be late", "Room l2", "Govern the corner", "Lab 0 is open"]) assert.equal(repairOcr(keep), keep);
});

test("document text: Urdu months, 'Sep.' and 'agle Monday' are read by entities.ts", () => {
  assert.equal(normalizeDocumentText("آخری تاریخ 20 اکتوبر 2026"), "آخری تاریخ 20 October 2026");
  assert.equal(normalizeDocumentText("due Sep. 30"), "due Sep 30");
  assert.equal(normalizeDocumentText("Quiz agle Monday"), "Quiz next Monday");
});

test("document year: the term or the document's other dates, not 'next occurrence'", () => {
  const fall = documentYear("Fall 2026 course plan", NOW, TZ);
  assert.equal(fall.yearFor(9), 2026);
  assert.equal(fall.yearFor(1), 2027);
  assert.equal(documentYear("Spring 2027", NOW, TZ).yearFor(3), 2027);
  assert.equal(documentYear("Quiz 1 on 20 Sep 2026\nQuiz 2 on 2 Nov 2026", NOW, TZ).yearFor(9), 2026);
  assert.equal(documentYear("no dates here", NOW, TZ).yearFor(9), null);
});

test("week numbers: from the semester start in the document, else undated and flagged", () => {
  const start = semesterStart("Semester starts: 31 August 2026", NOW, TZ, documentYear("", NOW, TZ));
  assert.equal(start, "2026-08-31");
  assert.equal(weekToDate(7, "2026-08-31"), "2026-10-12");
  assert.equal(weekToDate(1, "2026-09-02"), "2026-08-31"); // week 1 starts on its Monday
  const [d] = extractDeadlines("Week 4: Assignment 1 due", NOW, TZ);
  assert.equal(d.date, null);
  assert.equal(d.needsSemesterStart, true);
  assert.ok(d.confidence < 95);
});

test("ranges: the end is the deadline, the start is kept", () => {
  assert.deepEqual(rangeToEnd("Midterm exams: 20–24 Oct 2026"), { line: "Midterm exams: 24 Oct 2026", start: "20 Oct 2026" });
  assert.deepEqual(rangeToEnd("Viva: Nov 23 - Nov 25, 2026"), { line: "Viva: Nov 25, 2026", start: "Nov 23, 2026" });
  assert.deepEqual(rangeToEnd("from 7 to 11 December 2026"), { line: "from 11 December 2026", start: "7 December 2026" });
  assert.deepEqual(rangeToEnd("Lecture 9:00-10:30"), { line: "Lecture 9:00-10:30", start: null });
  const [d] = extractDeadlines("Final exams: 14-18 December 2026", NOW, TZ);
  assert.equal(d.date, "2026-12-18");
  assert.equal(d.rangeStart, "14 December 2026");
});

test("multi-line records join a heading with its labelled lines (OCR blank lines allowed)", () => {
  const head = (l: string) => /exam|assignment/i.test(l);
  const date = (l: string) => /\d/.test(l) && !/assignment \d$/i.test(l);
  const [r] = joinRecords(["Midterm Exam", "", "Date: 15 Nov", "", "Time: 10 AM"], head, date);
  assert.equal(r.text, "Midterm Exam — Date: 15 Nov — Time: 10 AM");
  assert.equal(joinRecords(["Quiz", "Date:", "20/10/2026"], () => true, (l) => /\d/.test(l))[0].text, "Quiz — Date: 20/10/2026");
});

test("tables: header columns map title, date and time; day columns are classes", () => {
  const { rows } = readTables(["Assignment | Due | Weight", "Assignment 1 | 14 Oct 2026 | 10%", "", "Project | 30 Nov 2026 | 20%"]);
  assert.deepEqual(rows.map((r) => [r.title, r.date]), [["Assignment 1", "14 Oct 2026"], ["Project", "30 Nov 2026"]]);
  const { classes } = readTables(["Time | Monday | Tuesday", "9:00-10:00 AM | Calculus | Physics"]);
  assert.deepEqual(classes.map((c) => [c.title, c.day]), [["Calculus", 1], ["Physics", 2]]);
  const s = extractSchedules("Monday | 9:00-10:30 AM Calculus\nWednesday | 9:00-10:30 AM Calculus", NOW, TZ);
  assert.deepEqual(s.map((x) => [x.title, x.daysOfWeek]), [["Calculus", [1, 3]]]);
});

test("Roman Urdu / Urdu weekday at the start of a timetable line", () => {
  assert.deepEqual(urduWeekdayStart("Peer subah 9 baje Calculus"), { day: 1, rest: "subah 9 baje Calculus" });
  assert.equal(urduWeekdayStart("بدھ 11 بجے فزکس")?.day, 3);
  assert.equal(urduWeekdayStart("Calculus on Monday"), null);
});

test("tickets and notices: the departure time wins; a month-year period is not a deadline", () => {
  const [flight] = extractDeadlines("BOARDING PASS\nDate: 14 Oct 2026   Boarding: 06:15   Departure: 06:45", NOW, TZ);
  assert.equal(flight.date, "2026-10-14");
  assert.equal(flight.time, "6:45 AM");
  assert.ok(flight.confidence < 95, "non-academic items are always reviewed");
  assert.deepEqual(extractDeadlines("Electricity Bill\nBill Month: Oct 2026", NOW, TZ), []);
});

test("year inference: Fall 2026 puts September and November in 2026 and January in 2027, and says so", () => {
  const d = extractDeadlines("CS-401 - Fall 2026\nQuiz 1 on 14 Sep\nQuiz 3 on 18 Nov\nFinal exam: 12 Jan at 9 AM\nProject report due Jan 20", NOW, TZ);
  const by = (t: string) => d.find((x) => x.title.toLowerCase().includes(t));
  assert.equal(by("quiz 1")?.date, "2026-09-14", "past in the term, not next year");
  assert.equal(by("quiz 3")?.date, "2026-11-18");
  assert.equal(by("final")?.date, "2027-01-12");
  assert.equal(by("project")?.date, "2027-01-20");
  assert.ok(d.every((x) => x.yearInferred), "every date took its year from the term");
});

test("year inference: no term, dates in two years; a date without a year joins the nearer one", () => {
  const d = extractDeadlines("Quiz 4: 14 Dec 2026\nRevision quiz Dec 28\nFinal exam: 11 Jan 2027\nProject due Jan 20", NOW, TZ);
  const by = (t: string) => d.find((x) => x.title.toLowerCase().includes(t));
  assert.equal(by("revision")?.date, "2026-12-28");
  assert.equal(by("revision")?.yearInferred, true);
  assert.equal(by("project")?.date, "2027-01-20");
  assert.equal(by("project")?.yearInferred, true);
  assert.equal(by("quiz 4")?.yearInferred, undefined, "a written year is not inferred");
});

test("OCR auto-create guard: a misread title with a clear date and time is not auto-created below OCR 90", () => {
  const text = "Item | Due | Time\nBroject | 30 Nov 2026 | 5:00 PM";
  const [item] = extractDeadlines(text, NOW, TZ);
  assert.equal(item.title, "Broject");
  assert.equal(item.time, "5 PM");
  assert.ok(item.confidence >= DEADLINE_AUTO, `rules alone would auto-create (${item.confidence})`);
  const read = (method: string, ocr: number) => capOcrConfidence(extractDeadlines(text, NOW, TZ), method, ocr)[0].confidence;
  assert.equal(read("ocr", 84), DEADLINE_AUTO - 1);
  assert.equal(read("pdf-ocr", 89), DEADLINE_AUTO - 1);
  assert.equal(read("ocr", 94), item.confidence);
  assert.equal(read("ocr", 90), item.confidence);
  assert.equal(read("text", 84), item.confidence);
  assert.equal(read("pdf", 84), item.confidence);
});

test("header rows: a misread header is not an item; the real row keeps its own time", () => {
  assert.ok(isHeaderRow("Te | Day | Paper | Time"));
  assert.ok(isHeaderRow("Date   Day   Paper   Time"));
  assert.ok(isHeaderRow("Tareekh | Din | Parcha | Waqt"));
  assert.ok(isHeaderRow("تاریخ | دن | پرچہ | وقت"));
  for (const keep of ["Due Date", "Paper", "Calculus Paper", "Assignment 1 | Due", "Date | Physics"]) assert.equal(isHeaderRow(keep), false, keep);

  const sheet = ["Final Examination Date Sheet", "Te | Day | Paper | Time", "02-11-2026 | Monday | Calculus | 9:00 AM", "04-11-2026 | Wednesday | Physics | 1:00 PM"].join("\n");
  const items = extractDeadlines(sheet, NOW, TZ);
  assert.deepEqual(items.map((d) => [d.title, d.date, d.time]), [["Calculus", "2026-11-02", "9 AM"], ["Physics", "2026-11-04", "1 PM"]]);

  // The OCR'd photo: rows too broken to read as a table. The header line must not become an item.
  const photo = "Final E\n\nination: Date.\n\nte | Day | Paper | Time\n\n02-11-2026 f Monday | Cal\n\n00 AM";
  assert.ok(!extractDeadlines(photo, NOW, TZ).some((d) => /day|time/i.test(d.title)), "no header-row item");
});
