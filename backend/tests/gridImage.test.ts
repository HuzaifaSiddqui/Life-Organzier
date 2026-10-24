import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fillMissingSlots, findBlocks, gridSchedulesFromImage, IMAGE_GRID_MAX, looksLikeTimetable } from "../src/modules/documents/gridTimetable.js";
import { shutdownOcr } from "../src/modules/documents/textExtraction.js";

test.after(() => shutdownOcr());

test("timetable photos: worth the grid pass only with many clock times", () => {
  assert.ok(looksLikeTimetable("08:30 09:00 09:30 10:00 10:30 11:00"));
  assert.ok(!looksLikeTimetable("Assignment 1 due 12 Nov 2026 at 11:59 PM"));
});

test("header columns: a slot whose times weren't read is put back", () => {
  const cols = [
    { cx: 100, start: 510, end: 540 },
    { cx: 150, start: 540, end: 570 },
    { cx: 250, start: 600, end: 630 }, // 09:30 column missing in between
    { cx: 300, start: 630, end: 660 },
  ];
  assert.deepEqual(fillMissingSlots(cols).map((c) => [c.cx, c.start, c.end]), [[100, 510, 540], [150, 540, 570], [200, 570, 600], [250, 600, 630], [300, 630, 660]]);
});

test("class blocks: coloured fills found; thin grid lines ignored; touching blocks split at the dark bar", () => {
  const width = 200;
  const height = 60;
  const rgb = new Uint8Array(width * height * 3).fill(255);
  const paint = (x1: number, x2: number, y1: number, y2: number, c: [number, number, number]) => {
    for (let y = y1; y <= y2; y += 1) for (let x = x1; x <= x2; x += 1) rgb.set(c, (y * width + x) * 3);
  };
  for (let x = 20; x < width; x += 20) paint(x, x, 0, height - 1, [200, 200, 200]); // grid lines
  paint(10, 79, 10, 49, [212, 242, 248]); // block A
  paint(80, 85, 10, 49, [44, 62, 80]); // block B's dark left bar, touching A
  paint(86, 150, 10, 49, [227, 230, 236]); // block B
  const blocks = findBlocks(rgb, width, height);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => [b.x1, b.x2]).sort((a, b) => a[0] - b[0]), [[10, 79], [80, 150]]);
});

test("grid timetable image: each class with its day, start, length and room; reviewed, not auto-created", async () => {
  const image = readFileSync(new URL("./eval/documents/images/timetable-grid.png", import.meta.url));
  const found = await gridSchedulesFromImage(image, "eng");
  const got = found.map((s) => `${s.title} | ${s.daysOfWeek.join(",")} | ${s.time} | ${s.durationMinutes}`).sort();
  assert.deepEqual(got, [
    "CSC201 | 2,4 | 11:30 AM | 90", // Tue + Thu, same time and room: one weekly routine
    "CSC201 | 3 | 11:30 AM | 60", // Wed, touching the MTH231 block
    "CSE499 | 6 | 10 AM | 180",
    "ENG110 - G2 | 2 | 2 PM | 60", // "02:00" after noon
    "MTH231 | 3 | 10 AM | 90",
    "MTH231 | 5 | 8:30 AM | 90",
    "PHY101 - G1 | 1 | 8:30 AM | 90",
  ]);
  const byTitle = (t: string, day: number) => found.find((s) => s.title === t && s.daysOfWeek.includes(day));
  assert.equal(byTitle("PHY101 - G1", 1)?.room, "A-12");
  assert.equal(byTitle("CSE499", 6)?.room, "FYP Lab");
  assert.equal(byTitle("MTH231", 3)?.instructor, "Dr Sana Ali");
  assert.ok(found.every((s) => s.confidence <= IMAGE_GRID_MAX));
});
