import assert from "node:assert/strict";
import test from "node:test";
import { clockMinutes, timeMatches, titleMatches } from "../scripts/docMatch.js";

test("private manifest title match: distinctive words in any order, one OCR slip in long words, short words ignored", () => {
  assert.equal(titleMatches("Operating Systems final", "Final Exam: Operating Systems (CS-301)"), true);
  assert.equal(titleMatches("Assignment 3", "Asignment 3 submission"), true, "one letter off in a 5+ letter word");
  assert.equal(titleMatches("Quiz", "Quizz"), false, "short words must match exactly");
  assert.equal(titleMatches("Databases midterm", "Databases"), false, "every word is needed");
  assert.equal(titleMatches("of 3", "anything"), false, "no word long enough: never matches");
});

test("times compare as clock times", () => {
  assert.equal(clockMinutes("4 PM"), 960);
  assert.equal(clockMinutes("12:30 am"), 30);
  assert.ok(timeMatches("4 PM", "4:00 PM") && timeMatches("16:00", "4 PM") && timeMatches("", "9 AM"));
  assert.equal(timeMatches("4 PM", "4 AM"), false);
  assert.equal(timeMatches("4 PM", null), false);
});
