import assert from "node:assert/strict";
import test from "node:test";
import { citedLine } from "../src/modules/documents/extraction.js";

// DOC_EVIDENCE_V2: the model names a line number; code looks the line up (no quote copying, no fuzzy match).
const LINES = ["Physics Department", "Lab report due 14 Oct 2026 at 5 PM", "Quiz 2:", "Monday 19 October 2026, 10:00", "Fee notice"];

test("DOC_EVIDENCE_V2: the cited line must give the item's date (and time); a wrapped row may join its neighbour", () => {
  assert.equal(citedLine(LINES, 2, "2026-10-14", "5 PM"), LINES[1], "the line itself");
  assert.equal(citedLine(LINES, 2, "2026-10-14", null), LINES[1], "no time: the date is enough");
  assert.equal(citedLine(LINES, 3, "2026-10-19", "10 AM"), `${LINES[2]} ${LINES[3]}`, "wrapped row: the line with the next");
  assert.equal(citedLine(LINES, 4, "2026-10-19", "10 AM"), LINES[3]);
  assert.equal(citedLine(LINES, 1, "2026-10-14", null), `${LINES[0]} ${LINES[1]}`, "off by one: joined with the next line only");
  assert.equal(citedLine(LINES, 5, "2026-10-14", null), null, "the date is not on or next to the cited line");
  assert.equal(citedLine(LINES, 2, "2026-10-15", null), null, "wrong date");
  assert.equal(citedLine(LINES, 2, "2026-10-14", "9 AM"), null, "wrong time");
  assert.equal(citedLine(LINES, 0, "2026-10-14", null), null, "no line 0");
  assert.equal(citedLine(LINES, 99, "2026-10-14", null), null, "past the end");
});
