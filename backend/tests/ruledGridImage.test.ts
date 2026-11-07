import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analyzeDocument } from "../src/modules/documents/documentProcessing.js";
import { IMAGE_GRID_MAX } from "../src/modules/documents/gridTimetable.js";
import {
  cellFields,
  clearCornerMarker,
  findCellBlocks,
  findRuledGrid,
  hasCornerMarker,
  headerTime,
  repairClippedTitles,
  ruledGridSchedulesFromImage,
  slotTimes,
  type Gray,
} from "../src/modules/documents/ruledGrid.js";
import { shutdownOcr } from "../src/modules/documents/textExtraction.js";

test.after(() => shutdownOcr());

/** A white canvas with a header band and 3 day rows of 6 slot columns (40 px), plus helpers to draw on it. */
function canvas() {
  const width = 360;
  const height = 260;
  const gray = new Uint8Array(width * height).fill(255);
  const rgb = new Uint8Array(width * height * 3).fill(255);
  const set = (x: number, y: number, v: number, c: [number, number, number] = [v, v, v]) => {
    gray[y * width + x] = v;
    rgb.set(c, (y * width + x) * 3);
  };
  const hline = (y: number, v = 40) => { for (let x = 10; x < 350; x += 1) set(x, y, v); };
  const vline = (x: number, y1: number, y2: number, v = 120) => { for (let y = y1; y <= y2; y += 1) set(x, y, v); };
  const ys = [20, 60, 120, 180, 240]; // header 20-60, rows 60-120, 120-180, 180-240
  const xs = [10, 110, 150, 190, 230, 270, 310, 350]; // label column 10-110, slots of 40 px
  for (const y of ys) hline(y);
  for (const x of xs) vline(x, 20, 60);
  for (const x of [10, 110, 350]) vline(x, 20, 240, 40);
  return { width, height, gray, rgb, set, vline, ys, xs, g: (): Gray => ({ data: gray, width, height }) };
}

test("ruled grid: header band, label column and slot columns from the table's own lines", () => {
  const c = canvas();
  const grid = findRuledGrid(c.g());
  assert.ok(grid);
  assert.deepEqual(grid.header, { start: 20, end: 60 });
  assert.deepEqual(grid.labels, { start: 10, end: 110 });
  assert.equal(grid.columns.length, 6);
  assert.deepEqual(grid.rows.map((r) => [r.start, r.end]), [[60, 120], [120, 180], [180, 240]]);
  // No table (a page of text, a photo): nothing found, no OCR started.
  assert.equal(findRuledGrid({ data: new Uint8Array(200 * 100).fill(255), width: 200, height: 100 }), null);
});

test("class cells: a run of slots with no line inside; a corner marker splits touching classes; empty cells skipped", () => {
  const c = canvas();
  const s = c.xs.slice(1); // slot starts: 110, 150, 190, 230, 270, 310
  const paint = (x0: number, y0: number, w: number, h: number) => { for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) c.set(x, y, 30); };
  // Row 0 (y 60-120): a class over slots 0-2, then one over slots 3-4 touching it (no line between), then a line.
  paint(118, 80, 60, 8);
  for (let y = 61; y < 75; y += 1) for (let x = s[3] + 1; x < s[3] + 15 - (y - 61); x += 1) c.set(x, y, 120, [216, 27, 27]);
  paint(s[3] + 10, 85, 40, 8);
  c.vline(s[5], 60, 120, 170);
  // Row 1: empty cells between light lines. Row 2: one class on slot 5 alone.
  for (const x of s.slice(1)) c.vline(x, 120, 180, 170);
  for (const x of s.slice(1)) c.vline(x, 180, 240, 170);
  paint(s[5] + 6, 200, 25, 8);

  const grid = findRuledGrid(c.g());
  assert.ok(grid);
  assert.equal(hasCornerMarker(c.rgb, c.width, s[3], 60, 40, 60), true);
  assert.equal(hasCornerMarker(c.rgb, c.width, s[2], 60, 40, 60), false);
  const blocks = findCellBlocks(c.g(), c.rgb, grid);
  assert.deepEqual(blocks.map((b) => [b.row, b.first, b.last]), [[0, 0, 2], [0, 3, 4], [2, 5, 5]]);
});

test("header times: '8:30 AM' per column; 12-hour clock rolls past noon; unread columns filled at the step", () => {
  assert.deepEqual(headerTime("1\n8:30\nAM"), { minutes: 510, half: "am" });
  assert.deepEqual(headerTime("12:30\nPM"), { minutes: 750, half: "pm" });
  assert.deepEqual(headerTime("14:00"), { minutes: 840, half: "pm" });
  assert.equal(headerTime("Campus"), null);
  const read = ["8:30 AM", "9:00 AM", null, "10:00 AM", "10:30 AM", "11:00 AM", "11:30 AM", "12:00 PM", "12:30", "1:00", "1:30"].map((t) => (t ? headerTime(t) : null));
  const starts = slotTimes(read);
  assert.ok(starts);
  assert.equal(starts[2], 570, "the unread 9:30 column is filled");
  assert.deepEqual(starts.slice(-3), [750, 780, 810], "12:30, 1:00, 1:30 are afternoon");
  // A misread that goes backwards is ignored; too little read is not trusted.
  assert.equal(slotTimes([headerTime("8:30 AM"), headerTime("9:00 AM"), headerTime("3:30 AM"), headerTime("10:00 AM")])?.[2], 570);
  assert.equal(slotTimes([headerTime("8:30 AM"), null, null, null, null, null]), null);
});

test("class cell lines: title, teacher without section code, room at the bottom (any case)", () => {
  assert.deepEqual(cellFields(["SQE SP24-BSE-C", "Ayesha Muqadas", "D-113"]), { title: "SQE SP24-BSE-C", instructor: "Ayesha Muqadas", room: "D-113" });
  assert.deepEqual(cellFields(["DIP", "sp24-bcs-b", "D-115"]), { title: "DIP", instructor: null, room: "D-115" });
  assert.deepEqual(cellFields(["Intro to Psych", "Syeda Fatima sp2", "A-6"]), { title: "Intro to Psych", instructor: "Syeda Fatima", room: "A-6" });
  assert.deepEqual(cellFields(["DevOps Lab", "hamza Hamid", "c9"]), { title: "DevOps Lab", instructor: "hamza Hamid", room: "C9" });
  assert.deepEqual(cellFields(["« DevOps", "hamza Hamid", "N-25-A"])?.title, "DevOps", "stray mark before the title dropped");
  assert.equal(cellFields(["12", "|"]), null, "no title");
});

test("titles cut by a corner marker take the full title of another class; real short titles stay", () => {
  assert.deepEqual(repairClippedTitles(["tro to Psych", "Intro to Psychology", "DevOps", "DevOps Lab", "ated Software Testing", "Automated Software Testing"]), [
    "Intro to Psychology",
    "Intro to Psychology",
    "DevOps",
    "DevOps Lab",
    "Automated Software Testing",
    "Automated Software Testing",
  ]);
});

test("corner marker cleared by colour: black text drawn over a red triangle survives", () => {
  const w = 30;
  const h = 30;
  const rgb = new Uint8Array(w * h * 3).fill(255);
  for (let y = 0; y < 20; y += 1) for (let x = 0; x < 20 - y; x += 1) rgb.set([216, 27, 27], (y * w + x) * 3);
  rgb.set([0, 0, 0], (5 * w + 10) * 3); // a text pixel on the triangle
  clearCornerMarker(rgb, w, h);
  assert.deepEqual([...rgb.subarray(0, 3)], [255, 255, 255], "triangle gone");
  assert.deepEqual([...rgb.subarray((5 * w + 10) * 3, (5 * w + 10) * 3 + 3)], [0, 0, 0], "text kept");
});

test("ruled grid timetable image: each class with its day, start, length, room and teacher; reviewed", async () => {
  const image = readFileSync(new URL("./eval/documents/images/timetable-ruled.png", import.meta.url));
  const found = await ruledGridSchedulesFromImage(image, "eng");
  const got = found.map((s) => `${s.title} | ${s.daysOfWeek.join(",")} | ${s.time} | ${s.durationMinutes} | ${s.room} | ${s.instructor}`).sort();
  assert.deepEqual(got, [
    "Compilers | 1 | 9:30 AM | 120 | D-113 | Usman Tariq", // touches Data Mining, no line between
    "Data Mining | 1,3 | 8:30 AM | 60 | A-6 | Sana Ali", // Mon + Wed, same time and room: one routine
    "Ethics | 2 | 11:30 AM | 60 | N-23 | Hina Raza", // black marker
    "Graphics | 4 | 10 AM | 90 | D-8 | Bilal Khan",
    "Networks Lab | 5 | 12:30 PM | 120 | C-19 | Ayesha Noor", // past noon
  ]);
  assert.ok(found.every((s) => s.confidence <= IMAGE_GRID_MAX));
});

test("upload: a ruled grid image is read as a grid (method image-grid) when the coloured-block reader finds nothing", async () => {
  const image = readFileSync(new URL("./eval/documents/images/timetable-ruled.png", import.meta.url));
  const a = await analyzeDocument({ buffer: image, fileName: "timetable.png", mimeType: "image/png", docType: "SCHEDULE", language: "eng", tz: "Asia/Karachi" });
  assert.equal(a.method, "image-grid");
  assert.equal(a.schedules.length, 5);
});
