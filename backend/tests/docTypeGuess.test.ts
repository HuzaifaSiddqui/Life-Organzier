import assert from "node:assert/strict";
import test from "node:test";
import { guessDocType } from "../src/modules/documents/docTypeGuess.js";

test("doc type guess: a course outline is a syllabus", () => {
  const text = `CS-301 Software Engineering
Course Outline
Credit Hours: 3
Course Objectives: ...
Learning Outcomes (CLOs)
Week 1: Introduction
Week 2: Requirements
Grading Policy: Quizzes 10%, Midterm 30%, Final 40%
Recommended Books: Sommerville`;
  assert.equal(guessDocType(text, "se-outline.pdf"), "SYLLABUS");
});

test("doc type guess: a timetable is a schedule", () => {
  const text = `BSE Fall 2026 Timetable
Monday 08:30 - 10:00 Software Design Room 12
Tuesday 10:00 - 11:30 Database Systems Room 4
Wednesday 08:30 - 10:00 Software Design Room 12
Thursday 13:00 - 14:30 Operating Systems Lab 2`;
  assert.equal(guessDocType(text, "timetable.png"), "SCHEDULE");
  assert.equal(guessDocType("Final exam date sheet\nMon 9:00 Physics\nWed 9:00 Maths", "ds.pdf"), "SCHEDULE");
});

test("doc type guess: anything else stays OTHER (never NOTES, which would skip deadlines)", () => {
  assert.equal(guessDocType("Fee voucher. Last date to pay: 20 November 2026. Late fee applies after.", "voucher.pdf"), "OTHER");
  assert.equal(guessDocType("Dear Ali, thanks for the meeting today.", "letter.docx"), "OTHER");
  assert.equal(guessDocType("", ""), "OTHER");
});
