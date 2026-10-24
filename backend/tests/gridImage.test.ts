import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analyzeDocument } from "../src/modules/documents/documentProcessing.js";
import { fillMissingSlots, findBlocks, gridSchedulesFromImage, hasClockGrid, IMAGE_GRID_MAX, looksLikeTimetable, normalizeRoom, weekdayLabels } from "../src/modules/documents/gridTimetable.js";
import { shutdownOcr } from "../src/modules/documents/textExtraction.js";

test.after(() => shutdownOcr());

test("timetable gate: a bill, a mark sheet and a datesheet never start the grid pass; a timetable does", () => {
  const bill = "Electricity Bill October 2026\nUnits consumed 345.00\nAmount Rs. 1200.00\nDue date 15.10.2026\nLate fee 15.00\nTotal Rs. 1215.00\nPay at any branch Monday to Friday";
  const markSheet = "Result Card\nCalculus 78.50\nPhysics 66.00\nEnglish 81.25\nCGPA 3.50\nDeclared on Monday, collect on Tuesday or Wednesday";
  const datesheet = [
    "Final Examination Date Sheet",
    "Date | Day | Paper | Time",
    "02-11-2026 | Monday | Calculus | 9:00 AM - 12:00 PM",
    "03-11-2026 | Tuesday | Physics | 2:00 PM - 5:00 PM",
    "04-11-2026 | Wednesday | English | 9:00 AM - 12:00 PM",
    "05-11-2026 | Thursday | Chemistry | 2:00 PM - 5:00 PM",
    "06-11-2026 | Friday | Urdu | 9:00 AM - 12:00 PM",
    "07-11-2026 | Saturday | Islamiat | 2:00 PM - 5:00 PM",
  ].join("\n");
  for (const [name, text] of [["bill", bill], ["mark sheet", markSheet], ["datesheet", datesheet]] as const) {
    assert.equal(hasClockGrid(text), false, `${name}: grid pass not started`);
    assert.equal(looksLikeTimetable(text), false, name);
  }
  const header = "Mo\nTu\nWe\n08:30 09:00 09:30 10:00 10:30 11:00 11:30";
  assert.ok(hasClockGrid(header) && looksLikeTimetable(header));
  assert.deepEqual([...weekdayLabels("Peer\nMangal\nبدھ")].sort(), [1, 2, 3]);
  assert.equal(weekdayLabels("We will meet soon").size, 0, "'We' in a sentence is not Wednesday");
});

test("timetable image: an upload is read as a grid (method image-grid), classes to review", async () => {
  const image = readFileSync(new URL("./eval/documents/images/timetable-grid.png", import.meta.url));
  const a = await analyzeDocument({ buffer: image, fileName: "timetable.png", mimeType: "image/png", docType: "SCHEDULE", language: "eng", tz: "Asia/Karachi" });
  assert.equal(a.method, "image-grid");
  assert.equal(a.schedules.length, 7);
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

test("rooms read from an image: hyphen restored for 'D118'; odd ones flagged for checking, never guessed", () => {
  assert.deepEqual(normalizeRoom("D118"), { room: "D-118", check: false });
  assert.deepEqual(normalizeRoom("D 8"), { room: "D-8", check: false });
  for (const ok of ["D-8", "N-25-A", "C-5", "SE Lab-J (C-9)", "CS Lab-FYP (C-12)"]) assert.deepEqual(normalizeRoom(ok), { room: ok, check: false }, ok);
  for (const odd of ["p17", "p-117", "0-3", "Nn-1158", "CS Lob-FYP FYP (C12)"]) assert.deepEqual(normalizeRoom(odd), { room: odd, check: true }, odd);
  assert.deepEqual(normalizeRoom(null), { room: null, check: false });
});
