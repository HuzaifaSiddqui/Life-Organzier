import { RoutineFrequency } from "@prisma/client";
import sharp from "sharp";
import { PSM, type Worker } from "tesseract.js";
import { formatClockFromMinutes } from "../../lib/time.js";
import type { ExtractedSchedule } from "./extraction.js";
import { IMAGE_GRID_MAX, normalizeRoom } from "./gridTimetable.js";
import { ocrLanguages, withWorker } from "./textExtraction.js";

/**
 * Ruled grid timetables in an image (timetable-generator exports, "My Version" screenshots): a table of
 * day rows and one-slot columns ("1 / 8:30 AM"), each class a merged cell with white fill. Unlike the
 * coloured-block reader in gridTimetable.ts this finds the table's own lines: a class is a run of cells with
 * no column line inside it, started by a corner marker (a coloured triangle) or a column line, and with
 * text in it. Each cell is then read on its own: header time, day label, class lines (title, teacher, room).
 *
 * Pixel work is pure (and unit-tested); OCR is per cell, so a 7 × 24 grid takes seconds, not minutes.
 */

export type Gray = { data: Uint8Array; width: number; height: number };
export type Span = { start: number; end: number };
export type RuledGrid = { header: Span; labels: Span; columns: Span[]; rows: Span[] };
export type CellBlock = { row: number; first: number; last: number; x1: number; x2: number; y1: number; y2: number };

/** Grey enough to be a ruling line or text (not the white page, not a pale tint). */
const LINE = 215;
const INK = 140;
const GRID_WIDTH = 2400;

const lum = (rgb: Uint8Array, i: number) => 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];

/** Adjacent pixel positions (a 2 px line) become one line at their centre. */
function merge(positions: number[]): number[] {
  const out: number[][] = [];
  for (const p of positions) {
    const last = out[out.length - 1];
    if (last && p - last[last.length - 1] <= 2) last.push(p);
    else out.push([p]);
  }
  return out.map((g) => Math.round((g[0] + g[g.length - 1]) / 2));
}

/** Rows of the image that are a line across at least `minFrac` of its width. */
export function horizontalLines(g: Gray, minFrac = 0.4): number[] {
  const ys: number[] = [];
  for (let y = 0; y < g.height; y += 1) {
    let n = 0;
    for (let x = 0; x < g.width; x += 1) if (g.data[y * g.width + x] < LINE) n += 1;
    if (n > g.width * minFrac) ys.push(y);
  }
  return merge(ys);
}

/** Share of [y1, y2] at column x (±1 px) darker than `dark`. */
export function verticalCover(g: Gray, x: number, y1: number, y2: number, dark = LINE): number {
  let n = 0;
  for (let y = y1; y <= y2; y += 1) {
    let hit = false;
    for (let dx = -1; dx <= 1 && !hit; dx += 1) {
      const cx = x + dx;
      if (cx >= 0 && cx < g.width && g.data[y * g.width + cx] < dark) hit = true;
    }
    if (hit) n += 1;
  }
  return n / Math.max(1, y2 - y1 + 1);
}

/** Columns of the image with a line through (nearly) all of the band [y1, y2]. */
export function verticalLines(g: Gray, y1: number, y2: number): number[] {
  const a = y1 + 2;
  const b = y2 - 2;
  if (b <= a) return [];
  const xs: number[] = [];
  for (let x = 0; x < g.width; x += 1) {
    let n = 0;
    for (let y = a; y <= b; y += 1) if (g.data[y * g.width + x] < LINE) n += 1;
    if (n >= (b - a + 1) * 0.9) xs.push(x);
  }
  return merge(xs);
}

/**
 * The table: the header band is the first gap between horizontal lines that is crossed by 6+ evenly spaced
 * column lines; the first column is the day labels, the rest are slots; every band below is a row.
 */
export function findRuledGrid(g: Gray): RuledGrid | null {
  const hs = horizontalLines(g);
  for (let h = 0; h + 1 < hs.length; h += 1) {
    const header = { start: hs[h], end: hs[h + 1] };
    if (header.end - header.start < 12) continue;
    const vs = verticalLines(g, header.start, header.end);
    if (vs.length < 8) continue;
    const spans = vs.slice(1).map((x, i) => ({ start: vs[i], end: x }));
    const slots = spans.slice(1);
    const widths = slots.map((s) => s.end - s.start).sort((a, b) => a - b);
    const median = widths[Math.floor(widths.length / 2)];
    // Slot columns are one width; a stray line (title underline) would make an odd one.
    if (median < 8 || slots.some((s) => Math.abs(s.end - s.start - median) > median * 0.3)) continue;
    const rows = hs.slice(h + 1).slice(1).map((y, i) => ({ start: hs[h + 1 + i], end: y })).filter((r) => r.end - r.start >= 12);
    if (rows.length < 3) return null;
    return { header, labels: spans[0], columns: slots, rows };
  }
  return null;
}

/** A corner marker (coloured or dark triangle) in the top-left of the cell starting at column `x`. */
export function hasCornerMarker(rgb: Uint8Array, width: number, x: number, rowTop: number, colW: number, rowH: number): boolean {
  let hits = 0;
  let n = 0;
  const xs = [Math.round(x + colW * 0.05), Math.round(x + colW * 0.1)];
  const ys = [Math.round(rowTop + rowH * 0.03), Math.round(rowTop + rowH * 0.05)];
  for (let px = xs[0]; px <= xs[1]; px += 1) {
    for (let py = ys[0]; py <= ys[1]; py += 1) {
      const i = py * width + px;
      const r = rgb[i * 3];
      const gg = rgb[i * 3 + 1];
      const b = rgb[i * 3 + 2];
      n += 1;
      if (lum(rgb, i) < 225 || Math.max(r, gg, b) - Math.min(r, gg, b) > 40) hits += 1;
    }
  }
  return n > 0 && hits / n >= 0.7;
}

/** Share of a box's inside (margins left out) dark enough to be text. */
function inkShare(g: Gray, x1: number, x2: number, y1: number, y2: number): number {
  const mx = Math.max(3, Math.round((x2 - x1) * 0.06));
  const my = Math.max(3, Math.round((y2 - y1) * 0.06));
  let n = 0;
  let ink = 0;
  for (let y = y1 + my; y < y2 - my; y += 1) {
    for (let x = x1 + mx; x < x2 - mx; x += 1) {
      n += 1;
      if (g.data[y * g.width + x] < INK) ink += 1;
    }
  }
  return n ? ink / n : 0;
}

/**
 * Class cells, row by row: a cell edge is a column line through the row or a corner marker (two classes can
 * touch with no line between them); a run of slots between edges with text in it is one class.
 */
export function findCellBlocks(g: Gray, rgb: Uint8Array, grid: RuledGrid): CellBlock[] {
  const out: CellBlock[] = [];
  const colW = grid.columns[0].end - grid.columns[0].start;
  grid.rows.forEach((row, r) => {
    const rowH = row.end - row.start;
    const y1 = row.start + 2;
    const y2 = row.end - 2;
    const edge = grid.columns.map((c, i) => i === 0 || verticalCover(g, c.start, y1, y2) >= 0.8 || hasCornerMarker(rgb, g.width, c.start, row.start, colW, rowH));
    let first = 0;
    for (let i = 1; i <= grid.columns.length; i += 1) {
      if (i < grid.columns.length && !edge[i]) continue;
      const x1 = grid.columns[first].start;
      const x2 = grid.columns[i - 1].end;
      if (inkShare(g, x1, x2, row.start, row.end) > 0.004) out.push({ row: r, first, last: i - 1, x1, x2, y1: row.start, y2: row.end });
      first = i;
    }
  });
  return out;
}

const TIME_IN = /(\d{1,2})\s*[:.]\s*(\d{2})/;
const DAY_IN = /\b(mon|tue|wed|thu|fri|sat|sun|mo|tu|we|th|fr|sa|su)[a-z]*\b/i;
const DAY_INDEX: Record<string, number> = { su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6 };

/** "8:30\nAM" → minutes, or null. A time without am/pm is kept 12-hour (null half). */
export function headerTime(text: string): { minutes: number; half: "am" | "pm" | null } | null {
  const m = text.replace(/[Oo](?=\d|:)/g, "0").match(TIME_IN);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 1 || h > 23 || min > 59) return null;
  // "14:00" is already 24-hour.
  if (h > 12) return { minutes: h * 60 + min, half: "pm" };
  const half = /\bp\.?\s?m\b/i.test(text) ? "pm" : /\ba\.?\s?m\b/i.test(text) ? "am" : null;
  return { minutes: (h % 12) * 60 + min + (half === "pm" ? 720 : 0), half };
}

/**
 * Slot start times from what was read per column: am/pm when given, else the clock goes forward (12:30 → 1:00
 * is past noon). Unread columns are filled at the usual step. Null when too little was read to trust.
 */
export function slotTimes(read: Array<{ minutes: number; half: "am" | "pm" | null } | null>): number[] | null {
  const known: Array<{ i: number; v: number }> = [];
  let prev = -1;
  read.forEach((t, i) => {
    if (!t) return;
    let v = t.minutes;
    if (t.half === null) {
      v = t.minutes % 720;
      while (prev >= 0 && v <= prev) v += 720;
    }
    if (prev >= 0 && v <= prev) return; // a misread that goes backwards
    known.push({ i, v });
    prev = v;
  });
  if (known.length < Math.max(3, read.length * 0.5)) return null;
  const steps = known.slice(1).map((k, j) => (k.v - known[j].v) / (k.i - known[j].i)).sort((a, b) => a - b);
  const step = steps[Math.floor(steps.length / 2)];
  if (!(step >= 10 && step <= 180)) return null;
  // Every column from its nearest read neighbour, so one misread can't shift the rest.
  return read.map((_, i) => {
    const near = known.reduce((a, b) => (Math.abs(b.i - i) < Math.abs(a.i - i) ? b : a));
    return near.v + (i - near.i) * step;
  });
}

/** A room as printed at the bottom of a cell: "D-113", "N-25-A", "C9", "O-1". */
const ROOM_LINE = /^[A-Z0-9]{1,3}\s?-?\s?\d{1,3}(?:-[A-Z])?$/;
/** Section codes printed next to a teacher: "sp23-bcs-b", "FA24-BSE-C". */
const SECTION = /(?:^|\s+)(?:sp|fa|su)\d.*$/i;

/** Title, teacher and room from a class cell's lines (in reading order). */
export function cellFields(lines: string[]): { title: string; instructor: string | null; room: string | null } | null {
  const clean = lines.map((l) => l.replace(/^[^\p{L}\p{N}]+/u, "").replace(/\s+/g, " ").trim()).filter((l) => (l.match(/[\p{L}\p{N}]/gu) ?? []).length >= 2);
  if (!clean.length) return null;
  let room: string | null = null;
  const last = clean[clean.length - 1].toUpperCase().replace(/^0(?=-?\d)/, "O");
  if (clean.length > 1 && ROOM_LINE.test(last)) {
    room = last;
    clean.pop();
  }
  const title = clean[0];
  if (!/\p{L}{2}/u.test(title)) return null;
  const teacher = clean[1]?.replace(SECTION, "").trim() || null;
  return { title, instructor: teacher, room };
}

/** One cell cropped from the upright image, enlarged so small print reads, its corner marker cleared. */
async function cellImage(upright: Buffer, scale: number, box: { x1: number; x2: number; y1: number; y2: number }, marker: boolean): Promise<Buffer> {
  const left = Math.max(0, Math.round((box.x1 + 3) * scale));
  const top = Math.max(0, Math.round((box.y1 + 3) * scale));
  const width = Math.max(8, Math.round((box.x2 - box.x1 - 6) * scale));
  const height = Math.max(8, Math.round((box.y2 - box.y1 - 6) * scale));
  const factor = Math.min(4, Math.max(1.5, 320 / height));
  const { data, info } = await sharp(upright).extract({ left, top, width, height }).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  if (marker) clearCornerMarker(data, info.width, info.height);
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } })
    .resize({ width: Math.round(width * factor), kernel: "lanczos3" })
    .grayscale()
    .normalise()
    .png()
    .toBuffer();
}

/**
 * The corner triangle reads as a stray letter. Its size is measured along the top row; inside it, only pixels of
 * its own colour (or the anti-aliased mix of it and white) are painted white, so black text drawn over a coloured
 * triangle survives. A black triangle takes black text over it with it: repairClippedTitles covers that. In place.
 */
export function clearCornerMarker(rgb: Uint8Array, width: number, height: number): void {
  const at = (x: number, y: number) => (y * width + x) * 3;
  const seed = at(1, 1);
  const colour = [rgb[seed], rgb[seed + 1], rgb[seed + 2]];
  const close = (i: number) => Math.abs(rgb[i] - colour[0]) + Math.abs(rgb[i + 1] - colour[1]) + Math.abs(rgb[i + 2] - colour[2]) < 120;
  // The diagonal edge is anti-aliased: a mix of the marker colour and white.
  const sumC = colour[0] + colour[1] + colour[2];
  const blend = (i: number) => {
    if (sumC > 700) return false;
    const t = (rgb[i] + rgb[i + 1] + rgb[i + 2] - sumC) / (765 - sumC);
    if (t < 0 || t > 1) return false;
    return colour.reduce((s, c, k) => s + Math.abs(rgb[i + k] - (c + t * (255 - c))), 0) < 70;
  };
  let size = 0;
  while (size < width && close(at(size, 1))) size += 1;
  size = Math.min(size + 2, width, height);
  for (let y = 0; y < size + 3 && y < height; y += 1) {
    for (let x = 0; x + y < size + 4 && x < width; x += 1) {
      const i = at(x, y);
      if (close(i) || blend(i)) rgb.fill(255, i, i + 3);
    }
  }
}

/**
 * A title whose first letters were lost under a corner marker ("tro to Psych") takes the title of another class
 * it is the tail of ("Intro to Psychology"). Only a cut of 1-5 letters at the start; "DevOps" stays "DevOps".
 */
export function repairClippedTitles(titles: string[]): string[] {
  return titles.map((t) => {
    const probe = t.toLowerCase().slice(0, Math.max(5, Math.ceil(t.length * 0.6)));
    if (probe.length < 5) return t;
    const full = titles.find((o) => {
      if (o === t || o.length <= t.length - 2) return false;
      const at = o.toLowerCase().indexOf(probe);
      return at >= 1 && at <= 5;
    });
    return full ?? t;
  });
}

async function readLines(worker: Worker, image: Buffer): Promise<string[]> {
  const { data } = await worker.recognize(image);
  return data.text.split(/\n+/).map((l) => l.replace(/[|¦”“’‘"`¥]/g, "").trim()).filter(Boolean);
}

/**
 * Classes from a ruled grid timetable image, or [] when the image has no such table. Read from a photo,
 * so they are reviewed, never created on their own (confidence ≤ IMAGE_GRID_MAX).
 */
export async function ruledGridSchedulesFromImage(buffer: Buffer, language: string, deadline = Infinity): Promise<ExtractedSchedule[]> {
  const upright = await sharp(buffer).rotate().toBuffer();
  const originalWidth = (await sharp(upright).metadata()).width ?? GRID_WIDTH;
  const base = sharp(upright).resize({ width: GRID_WIDTH }).removeAlpha().toColourspace("srgb");
  const { data: gray, info } = await base.clone().grayscale().raw().toBuffer({ resolveWithObject: true });
  const rgb = new Uint8Array(await base.clone().raw().toBuffer());
  const g: Gray = { data: new Uint8Array(gray), width: info.width, height: info.height };
  const grid = findRuledGrid(g);
  if (!grid) return [];
  const blocks = findCellBlocks(g, rgb, grid);
  if (blocks.length < 2) return [];
  const scale = originalWidth / GRID_WIDTH;
  const colW = grid.columns[0].end - grid.columns[0].start;

  const times: Array<ReturnType<typeof headerTime>> = [];
  const days: Array<number | null> = [];
  const found: Array<{ block: CellBlock; fields: NonNullable<ReturnType<typeof cellFields>> }> = [];
  await withWorker(ocrLanguages(language), async (worker) => {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    try {
      for (const c of grid.columns) {
        if (Date.now() > deadline) return;
        const img = await cellImage(upright, scale, { x1: c.start, x2: c.end, y1: grid.header.start, y2: grid.header.end }, false);
        times.push(headerTime((await readLines(worker, img)).join("\n")));
      }
      for (const r of grid.rows) {
        if (Date.now() > deadline) return;
        const img = await cellImage(upright, scale, { x1: grid.labels.start, x2: grid.labels.end, y1: r.start, y2: r.end }, false);
        const m = (await readLines(worker, img)).join(" ").match(DAY_IN);
        days.push(m ? DAY_INDEX[m[1].slice(0, 2).toLowerCase()] : null);
      }
      for (const block of blocks) {
        if (Date.now() > deadline) return;
        const rowH = block.y2 - block.y1;
        const marker = hasCornerMarker(rgb, g.width, block.x1, block.y1, colW, rowH);
        const fields = cellFields(await readLines(worker, await cellImage(upright, scale, block, marker)));
        if (fields) found.push({ block, fields });
      }
    } finally {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
    }
  });
  const starts = slotTimes(times);
  if (!starts || days.filter((d) => d !== null).length < 3) return [];
  const step = starts.length > 1 ? starts[1] - starts[0] : 30;

  // Same class at the same time and room on several days becomes one weekly routine.
  const titles = repairClippedTitles(found.map((f) => f.fields.title));
  const merged = new Map<string, ExtractedSchedule>();
  for (const [n, { block, fields: read }] of found.entries()) {
    const fields = { ...read, title: titles[n] };
    const day = days[block.row];
    if (day === null || day === undefined) continue;
    const start = starts[block.first];
    const end = block.last + 1 < starts.length ? starts[block.last + 1] : starts[block.last] + step;
    const room = normalizeRoom(fields.room);
    const key = `${fields.title.toLowerCase()}|${start}|${end}|${room.room ?? ""}`;
    const existing = merged.get(key);
    if (existing) {
      if (!existing.daysOfWeek.includes(day)) existing.daysOfWeek = [...existing.daysOfWeek, day].sort();
      continue;
    }
    merged.set(key, {
      index: merged.size,
      title: fields.title,
      frequency: RoutineFrequency.WEEKLY,
      daysOfWeek: [day],
      time: formatClockFromMinutes(start),
      durationMinutes: end - start,
      room: room.room,
      ...(room.check ? { roomCheck: true } : {}),
      instructor: fields.instructor,
      confidence: Math.min(80, IMAGE_GRID_MAX),
      source: `${fields.title} · grid photo`,
    });
  }
  return [...merged.values()];
}
