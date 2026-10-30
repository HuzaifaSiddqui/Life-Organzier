import assert from "node:assert/strict";
import { test } from "node:test";
import { extractEntities } from "../src/modules/assistant/entities.js";
import { dateGrounded, extractDeadlines } from "../src/modules/documents/extraction.js";

// Made-up date sheets (DOC_DATESHEET): dashed dates and rows with no "exam" on them.
const now = new Date("2026-10-30T11:00:00Z");
const tz = "Asia/Karachi";
const SHEET = "Midterm Date Sheet Fall 2026\nWed 4-Nov-2026 Data Structures 09:00\nThu 5-Nov Operating Systems 11:30";
const OCR = "2026\nMidterm Schedule\nWed_Data04-Nov-S_Data Structures (CS)\n09:00\n2026\nFri_Soft06-Nov-A_Software Quality (SE)";

function withFlag(on: boolean, fn: () => void) {
  const before = process.env.DOC_DATESHEET;
  process.env.DOC_DATESHEET = on ? "on" : "off";
  try {
    fn();
  } finally {
    if (before === undefined) delete process.env.DOC_DATESHEET;
    else process.env.DOC_DATESHEET = before;
  }
}

test("DOC_DATESHEET: '4-Nov', '04-Nov-2026' and '4-November-2026' are dates, in chat and in the AI date check", () => {
  withFlag(true, () => {
    for (const s of ["4-Nov-2026", "04-Nov", "4-November-2026", "4 - Nov - 2026"]) {
      assert.equal(extractEntities(`exam ${s}`, { now, tz }).date?.ymd, "2026-11-04", s);
      assert.ok(dateGrounded("2026-11-04", `Data Structures ${s}`), s);
    }
    assert.equal(extractEntities("meeting 4-5 pm", { now, tz }).date, null, "a time range is not a date");
  });
  withFlag(false, () => assert.equal(extractEntities("exam 4-Nov-2026", { now, tz }).date, null, "off: unchanged"));
});

test("DOC_DATESHEET: rows under a date-sheet heading are exams, without the weekday in the title", () => {
  withFlag(true, () => {
    const d = extractDeadlines(SHEET, now, tz);
    assert.deepEqual(d.map((x) => [x.title, x.date, x.time, x.activity]), [
      ["Data Structures", "2026-11-04", "9 AM", "exam"],
      ["Operating Systems", "2026-11-05", "11:30 AM", "exam"],
    ]);
    assert.deepEqual(extractDeadlines(OCR, now, tz).map((x) => x.date), ["2026-11-04", "2026-11-06"], "OCR glued cells");
    assert.equal(extractDeadlines("Lecture notes\nData Structures 4-Nov-2026", now, tz).length, 0, "no date-sheet heading: no exam");
  });
  withFlag(false, () => assert.equal(extractDeadlines(SHEET, now, tz).length, 0, "off: unchanged"));
});
