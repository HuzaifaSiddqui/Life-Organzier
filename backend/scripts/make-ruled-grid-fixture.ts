/**
 * Writes tests/eval/documents/images/timetable-ruled.png: a synthetic ruled grid timetable in the style of
 * timetable-generator exports ("My Version" screenshots): one start time per slot column, white class cells
 * with a coloured or black corner triangle, two classes touching with no line between them. Made-up names.
 *
 *   npx tsx scripts/make-ruled-grid-fixture.ts
 */
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const LEFT = 40;
const LABEL_W = 160;
const COL_W = 70;
const COLS = 12;
const TOP = 90;
const HEAD_H = 100;
const ROW_H = 140;
const DAYS = ["Mo", "Tu", "We", "Th", "Fr"];
const width = LEFT * 2 + LABEL_W + COL_W * COLS;
const height = TOP + HEAD_H + ROW_H * DAYS.length + 40;

type Block = { day: number; first: number; last: number; marker: string; title: string; teacher: string; room: string };
const blocks: Block[] = [
  { day: 0, first: 0, last: 1, marker: "#d81b1b", title: "Data Mining", teacher: "Sana Ali sp23-bcs-b", room: "A-6" },
  { day: 0, first: 2, last: 5, marker: "#1e88e5", title: "Compilers", teacher: "Usman Tariq", room: "D-113" }, // touches Data Mining
  { day: 1, first: 6, last: 7, marker: "#222222", title: "Ethics", teacher: "Hina Raza", room: "N-23" },
  { day: 2, first: 0, last: 1, marker: "#43a047", title: "Data Mining", teacher: "Sana Ali sp23-bcs-b", room: "A-6" }, // same as Monday
  { day: 3, first: 3, last: 5, marker: "#6a1b4d", title: "Graphics", teacher: "Bilal Khan", room: "D-8" },
  { day: 4, first: 8, last: 11, marker: "#fb8c00", title: "Networks Lab", teacher: "Ayesha Noor", room: "C-19" }, // past noon
];

const x0 = LEFT + LABEL_W;
const colX = (i: number) => x0 + i * COL_W;
const rowY = (d: number) => TOP + HEAD_H + d * ROW_H;
const clock = (i: number) => {
  const m = 8 * 60 + 30 + i * 30;
  const h = Math.floor(m / 60);
  return { t: `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")}`, half: h < 12 ? "AM" : "PM" };
};

const parts: string[] = [`<rect width="${width}" height="${height}" fill="white"/>`];
const text = (x: number, y: number, s: string, size: number, opts = "") => parts.push(`<text x="${x}" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" ${opts}>${s}</text>`);
text(width / 2, 40, "Spring 2027 Timetable - My Version", 26, 'text-anchor="middle"');

// Header: slot number, start time, AM/PM; grey column lines through it.
for (let i = 0; i < COLS; i += 1) {
  const c = clock(i);
  const cx = colX(i) + COL_W / 2;
  text(cx, TOP + 25, String(i + 1), 15, 'text-anchor="middle"');
  text(cx, TOP + 55, c.t, 16, 'text-anchor="middle" font-weight="bold"');
  text(cx, TOP + 75, c.half, 16, 'text-anchor="middle" font-weight="bold"');
}
for (let i = 0; i <= COLS; i += 1) parts.push(`<line x1="${colX(i)}" y1="${TOP}" x2="${colX(i)}" y2="${TOP + HEAD_H}" stroke="#777" stroke-width="1.5"/>`);
text(LEFT + 8, TOP + 25, "Campus", 16);

// Day rows: label, light lines between empty cells, none inside a class, dark edges around classes.
DAYS.forEach((day, d) => {
  const y = rowY(d);
  text(LEFT + LABEL_W / 2, y + ROW_H / 2 + 14, day, 42, 'text-anchor="middle"');
  const inRow = blocks.filter((b) => b.day === d);
  for (let i = 1; i < COLS; i += 1) {
    const inside = inRow.some((b) => i > b.first && i <= b.last);
    const touching = inRow.some((b) => b.first === i) && inRow.some((b) => b.last === i - 1);
    const edge = inRow.some((b) => b.first === i || b.last === i - 1);
    if (inside || touching) continue;
    parts.push(`<line x1="${colX(i)}" y1="${y}" x2="${colX(i)}" y2="${y + ROW_H}" stroke="${edge ? "#222" : "#aaa"}" stroke-width="1.5"/>`);
  }
  for (const b of inRow) {
    const bx = colX(b.first);
    const bw = (b.last - b.first + 1) * COL_W;
    parts.push(`<polygon points="${bx},${y} ${bx + 40},${y} ${bx},${y + 40}" fill="${b.marker}"/>`);
    text(bx + bw / 2, y + 22, b.title, 17, 'text-anchor="middle" font-weight="bold"');
    text(bx + bw / 2, y + 40, b.teacher, 13, 'text-anchor="middle"');
    text(bx + 10, y + ROW_H - 10, b.room, 15);
  }
});
for (let d = 0; d <= DAYS.length; d += 1) parts.push(`<line x1="${LEFT}" y1="${rowY(d)}" x2="${colX(COLS)}" y2="${rowY(d)}" stroke="#222" stroke-width="2"/>`);
parts.push(`<line x1="${LEFT}" y1="${TOP}" x2="${colX(COLS)}" y2="${TOP}" stroke="#222" stroke-width="2"/>`);
for (const x of [LEFT, x0, colX(COLS)]) parts.push(`<line x1="${x}" y1="${TOP}" x2="${x}" y2="${rowY(DAYS.length)}" stroke="#222" stroke-width="2"/>`);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("")}</svg>`;
const out = fileURLToPath(new URL("../tests/eval/documents/images/timetable-ruled.png", import.meta.url));
await sharp(Buffer.from(svg)).png().toFile(out);
console.log("wrote", out);
