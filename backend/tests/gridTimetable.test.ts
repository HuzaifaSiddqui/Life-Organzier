import assert from "node:assert/strict";
import test from "node:test";
import { classesFromLayout, type Rect, type TextItem } from "../src/modules/documents/gridTimetable.js";

// A miniature of a university grid timetable: 6 half-hour columns (11:30 .. 02:30, no am/pm),
// rows Mo..We, and a legend line below the grid.
const t = (str: string, x: number, y: number, w = 14, h = 5): TextItem => ({ str, x, y, w, h });
const header = ["11:30", "12:00", "12:30", "01:00", "01:30", "02:00", "02:30"];
const items: TextItem[] = [
  t("Mo", 27, 682, 13, 9),
  t("Tu", 28, 646, 10, 9),
  t("We", 27, 610, 12, 9),
  ...header.slice(0, 6).flatMap((s, i) => [t(s, 46 + i * 23, 712), t(header[i + 1], 46 + i * 23, 706)]),
  // Tue 11:30–1:00 in a box spanning 3 columns, room under the label.
  t("CSC461 - G1", 47, 661, 29),
  t("D-115", 47, 655, 11, 4),
  // Wed 1:00–2:30, then the same class on Tue at the same time → one routine on two days.
  t("CSC461 - G2", 116, 625, 29),
  t("D-117", 116, 619, 11, 4),
  t("CSC461 - G2", 116, 650, 29),
  t("D-117", 116, 644, 11, 4),
  // Legend
  t("CSC461", 27, 420, 17),
  t("G1", 46, 420, 6),
  t("- Introduction to Data Science", 54, 420, 80),
];
const rects: Rect[] = [
  { x1: 45, y1: 652, x2: 113, y2: 664 },
  { x1: 114, y1: 616, x2: 182, y2: 628 },
  { x1: 114, y1: 641, x2: 182, y2: 653 },
];

test("grid timetable: rows, columns, box durations, rooms, merged days and legend names", () => {
  const out = classesFromLayout(items, rects);
  assert.equal(out.length, 2);
  const g1 = out.find((s) => s.title.startsWith("CSC461 - G1"))!;
  assert.deepEqual(g1.daysOfWeek, [2]);
  assert.equal(g1.time, "11:30 AM");
  assert.equal(g1.durationMinutes, 90);
  assert.equal(g1.room, "D-115");
  assert.equal(g1.title, "CSC461 - G1 Introduction to Data Science");
  const g2 = out.find((s) => s.title.startsWith("CSC461 - G2"))!;
  assert.deepEqual(g2.daysOfWeek, [2, 3]);
  assert.equal(g2.time, "1 PM");
  assert.equal(g2.durationMinutes, 90);
});

test("grid timetable: plain documents produce nothing", () => {
  assert.deepEqual(classesFromLayout([t("Assignment 1 due October 20", 50, 700, 120)], []), []);
});
