import { RoutineFrequency } from "@prisma/client";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import sharp from "sharp";
import { PSM, type Worker } from "tesseract.js";
import { formatClockFromMinutes } from "../../lib/time.js";
import type { ExtractedSchedule } from "./extraction.js";
import { ocrLanguages, withWorker } from "./textExtraction.js";

/**
 * Grid timetables (days down the side, time slots across the top, classes drawn as boxes) lose
 * their layout when a PDF is read as plain text. This reads positions instead: day labels give the
 * rows, "08:30 / 09:00" header pairs give the columns, and each class label's surrounding box gives
 * its start and end slot.
 */

export type TextItem = { str: string; x: number; y: number; w: number; h: number };
export type Rect = { x1: number; y1: number; x2: number; y2: number };

const DAY_RE = /^(mon|tue|wed|thu|fri|sat|sun|mo|tu|we|th|fr|sa|su)[a-z]*\.?$/i;
const DAY_INDEX: Record<string, number> = { su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6 };
const TIME_RE = /^(\d{1,2})[:.](\d{2})\s*([ap]\.?m\.?)?$/i;
/** "CSC461", "CSC461 - G1", "CS 101", "MATH-201L" */
const COURSE_RE = /^[A-Z]{2,5}[\s-]?\d{3}[A-Z]?\b/;

type Row = { day: number; top: number; bottom: number };
type Col = { left: number; right: number; start: number; end: number };

function rows(items: TextItem[]): Row[] | null {
  const days = items.filter((i) => DAY_RE.test(i.str.trim()));
  if (days.length < 3) return null;
  // Day labels share a column: keep the label with the most neighbours within a few points, plus those neighbours.
  const near = (a: TextItem, b: TextItem) => Math.abs(a.x - b.x) < 8;
  const anchor = [...days].sort((a, b) => days.filter((d) => near(d, b)).length - days.filter((d) => near(d, a)).length)[0];
  const col = days.filter((d) => near(d, anchor)).sort((a, b) => b.y - a.y);
  if (col.length < 3) return null;
  const centers = col.map((d) => d.y + d.h / 2);
  const gap = (centers[0] - centers[centers.length - 1]) / (centers.length - 1);
  return col.map((d, i) => ({
    day: DAY_INDEX[d.str.trim().slice(0, 2).toLowerCase()],
    top: i === 0 ? centers[0] + gap / 2 : (centers[i - 1] + centers[i]) / 2,
    bottom: i === col.length - 1 ? centers[i] - gap / 2 : (centers[i] + centers[i + 1]) / 2,
  }));
}

function toMinutes(m: RegExpMatchArray): number {
  let h = Number(m[1]) % 12;
  if (m[3]?.toLowerCase().startsWith("p")) h += 12;
  return h * 60 + Number(m[2]);
}

function columns(items: TextItem[], gridTop: number): Col[] | null {
  const times = items.filter((i) => i.y > gridTop && TIME_RE.test(i.str.trim()));
  const groups: TextItem[][] = [];
  for (const t of times.sort((a, b) => a.x - b.x)) {
    const g = groups.find((gr) => Math.abs(gr[0].x - t.x) < 3);
    if (g) g.push(t);
    else groups.push([t]);
  }
  const pairs = groups.filter((g) => g.length === 2).map((g) => g.sort((a, b) => b.y - a.y));
  if (pairs.length < 4) return null;
  // Header times are often 12-hour without am/pm: "12:30, 01:00" means the clock went past noon.
  let prev = -1;
  let offset = 0;
  const raw = pairs.map(([a, b]) => {
    const fix = (t: TextItem) => {
      let v = toMinutes(t.str.trim().match(TIME_RE)!) + offset;
      if (prev >= 0 && v < prev) {
        offset += 12 * 60;
        v += 12 * 60;
      }
      prev = v;
      return v;
    };
    return { cx: a.x + a.w / 2, start: fix(a), end: fix(b) };
  });
  const full = fillMissingSlots(raw);
  return full.map((c, i) => {
    const half = ((full[i + 1]?.cx ?? c.cx + (c.cx - full[i - 1].cx)) - c.cx) / 2;
    return { left: c.cx - half, right: c.cx + half, start: c.start, end: c.end };
  });
}

/**
 * Header columns are evenly spaced, one slot each. A column whose times weren't read (a photo) leaves a gap
 * worth several slots: it is put back, so classes after it don't land one column early.
 */
export function fillMissingSlots(cols: Array<{ cx: number; start: number; end: number }>): Array<{ cx: number; start: number; end: number }> {
  if (cols.length < 2) return cols;
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const slot = median(cols.map((c) => c.end - c.start));
  if (!(slot > 0)) return cols;
  const steps = cols.slice(1).map((c, i) => ({ dt: c.start - cols[i].start, dx: c.cx - cols[i].cx })).filter((s) => s.dt === slot);
  if (!steps.length) return cols;
  const dx = median(steps.map((s) => s.dx));
  const out = [cols[0]];
  for (const c of cols.slice(1)) {
    const prev = out[out.length - 1];
    const k = Math.round((c.start - prev.start) / slot);
    for (let j = 1; j < k && Math.abs(c.cx - prev.cx - k * dx) < dx * 0.5; j += 1) out.push({ cx: prev.cx + j * dx, start: prev.start + j * slot, end: prev.end + j * slot });
    out.push(c);
  }
  return out;
}

/** Page-space boxes from the PDF's drawing operators (paths carry a bounding box in user space). */
async function rectsOf(page: { getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }> }): Promise<Rect[]> {
  const ops = await page.getOperatorList();
  const out: Rect[] = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const apply = (m: number[], x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  ops.fnArray.forEach((fn, i) => {
    const args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) {
      const [a, b, c, d, e, f] = args as number[];
      const m = ctm;
      ctm = [a * m[0] + b * m[2], a * m[1] + b * m[3], c * m[0] + d * m[2], c * m[1] + d * m[3], e * m[0] + f * m[2] + m[4], e * m[1] + f * m[3] + m[5]];
    } else if (fn === OPS.constructPath) {
      const mm = Object.values((args[2] ?? {}) as Record<string, number>);
      if (mm.length !== 4 || !mm.every(Number.isFinite)) return;
      const [p, q] = [apply(ctm, mm[0], mm[1]), apply(ctm, mm[2], mm[3])];
      out.push({ x1: Math.min(p[0], q[0]), y1: Math.min(p[1], q[1]), x2: Math.max(p[0], q[0]), y2: Math.max(p[1], q[1]) });
    }
  });
  return out;
}

export function classesFromLayout(items: TextItem[], rects: Rect[]): ExtractedSchedule[] {
  const rs = rows(items);
  if (!rs) return [];
  const cs = columns(items, rs[0].top);
  if (!cs) return [];
  const gridLeft = cs[0].left;
  const gridBottom = rs[rs.length - 1].bottom;
  const rowH = rs[0].top - rs[0].bottom;
  const colW = cs[0].right - cs[0].left;

  // Legend under the grid: "CSC461  G1  - Introduction to Data Science - Dr. Farooq Ahmad".
  const legend = new Map<string, string>();
  for (const code of items.filter((i) => i.y < gridBottom && COURSE_RE.test(i.str.trim()))) {
    const line = items
      .filter((i) => Math.abs(i.y - code.y) < 1.5 && i.x >= code.x && i.x < code.x + 280)
      .sort((a, b) => a.x - b.x)
      .map((i) => i.str.trim())
      .join(" ");
    const m = line.match(/^([A-Z]{2,5}[\s-]?\d{3}[A-Z]?)\s*(G\d+)?\s*-\s*([^-]+)/);
    if (m) legend.set(`${m[1]}${m[2] ? ` - ${m[2]}` : ""}`, m[3].trim());
  }

  const found: Array<{ title: string; day: number; start: number; end: number; room: string | null; instructor: string | null }> = [];
  for (const label of items) {
    const str = label.str.trim();
    const cy = label.y + label.h / 2;
    if (!COURSE_RE.test(str) || label.x < gridLeft || cy > rs[0].top || cy < gridBottom) continue;
    const row = rs.find((r) => cy <= r.top && cy > r.bottom);
    const startCol = cs.findIndex((c) => label.x + 1 >= c.left && label.x + 1 < c.right);
    if (!row || startCol < 0) continue;
    // The smallest drawn box around the label that is still slot-sized is the class block.
    const box = rects
      .filter((r) => r.x1 <= label.x + 1 && r.x2 >= label.x + label.w * 0.6 && r.y1 <= cy && r.y2 >= cy)
      .filter((r) => r.y2 - r.y1 <= rowH * 1.05 && r.x2 - r.x1 >= colW * 0.8)
      .sort((a, b) => (a.x2 - a.x1) * (a.y2 - a.y1) - (b.x2 - b.x1) * (b.y2 - b.y1))[0];
    let endCol = startCol;
    if (box) {
      // Ignore a sliver past a column border: box edges are often drawn a point or two wide.
      const edge = box.x2 - colW / 4;
      const hit = cs.findIndex((c) => edge >= c.left && edge < c.right);
      endCol = hit >= startCol ? hit : cs.length - 1;
    }
    // Lines inside the box under the label: instructor, then room on the last line.
    const inside = box
      ? items
          .filter((i) => i !== label && i.x >= box.x1 - 1 && i.x <= box.x2 && i.y + i.h / 2 >= box.y1 && i.y < label.y - 0.5)
          .sort((a, b) => b.y - a.y)
          .map((i) => i.str.trim())
          .filter(Boolean)
      : [];
    found.push({
      title: str.replace(/\s+/g, " "),
      day: row.day,
      start: cs[startCol].start,
      end: cs[endCol].end,
      room: inside.length ? inside[inside.length - 1] : null,
      instructor: inside.length > 1 ? inside[0] : null,
    });
  }

  // Same class at the same time on several days becomes one weekly routine.
  const merged = new Map<string, ExtractedSchedule>();
  for (const f of found) {
    const key = `${f.title}|${f.start}|${f.end}|${f.room ?? ""}`;
    const existing = merged.get(key);
    if (existing) {
      if (!existing.daysOfWeek.includes(f.day)) existing.daysOfWeek = [...existing.daysOfWeek, f.day].sort();
      continue;
    }
    const name = legend.get(f.title) ?? legend.get(f.title.split(/\s+-\s+/)[0]);
    merged.set(key, {
      index: merged.size,
      title: name ? `${f.title} ${name}` : f.title,
      frequency: RoutineFrequency.WEEKLY,
      daysOfWeek: [f.day],
      time: formatClockFromMinutes(f.start),
      durationMinutes: f.end > f.start ? f.end - f.start : null,
      room: f.room,
      instructor: f.instructor,
      confidence: f.end > f.start ? 92 : 80,
      source: `${f.title} · grid`,
    });
  }
  return [...merged.values()];
}

export async function gridSchedulesFromPdf(buffer: Buffer): Promise<ExtractedSchedule[]> {
  const doc = await getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
  try {
    const out: ExtractedSchedule[] = [];
    for (let p = 1; p <= Math.min(doc.numPages, 3); p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const items: TextItem[] = (content.items as Array<{ str?: string; transform?: number[]; width?: number }>)
        .filter((i) => i.str?.trim() && i.transform)
        .map((i) => ({ str: i.str as string, x: i.transform![4], y: i.transform![5], w: i.width ?? 0, h: Math.abs(i.transform![3]) }));
      const found = classesFromLayout(items, await rectsOf(page));
      for (const s of found) out.push({ ...s, index: out.length });
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

/* ------------------------------------------------------------------ images (photos, screenshots) */

/** Distinct clock times written with ":" ("08:30"); decimals like "1200.00" or "3.50" don't count. */
function distinctClockTimes(text: string): number {
  return new Set(text.match(/\b\d{1,2}:\d{2}\b/g) ?? []).size;
}

const WEEKDAY_WORD: Array<[RegExp, number]> = [
  [/\b(?:mon(?:day)?|peer|pir|somwaa?r)\b|پیر|سوموار/i, 1],
  [/\b(?:tue(?:s(?:day)?)?|mangal(?:waa?r)?)\b|منگل/i, 2],
  [/\b(?:wed(?:nesday)?|budh(?:waa?r)?)\b|بدھ/i, 3],
  [/\b(?:thu(?:rs?(?:day)?)?|jum[ea]ra{1,2}t)\b|جمعرات/i, 4],
  [/\b(?:fri(?:day)?|jumm?(?:a|ah|e))\b|جمعہ/i, 5],
  [/\b(?:sat(?:urday)?|hafta)\b|ہفتہ/i, 6],
  [/\b(?:sun(?:day)?|a?itwaa?r)\b|اتوار/i, 0],
];
/** Two-letter labels ("Mo", "Tu", "We") count only on a line of their own: "We" in a sentence is not Wednesday. */
const TWO_LETTER_DAY: Record<string, number> = { mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6, su: 0 };

/** Weekdays named in the text (English, Roman Urdu, Urdu), each counted once. */
export function weekdayLabels(text: string): Set<number> {
  const days = new Set<number>();
  for (const [re, day] of WEEKDAY_WORD) if (re.test(text)) days.add(day);
  for (const line of text.split("\n")) {
    const day = TWO_LETTER_DAY[line.trim().toLowerCase()];
    if (day !== undefined) days.add(day);
  }
  return days;
}

/**
 * A timetable: at least 3 different weekdays and 6 different ":" clock times. A bill (decimals), a mark sheet or
 * a datesheet (a few repeated slots) is not one.
 */
export function looksLikeTimetable(text: string): boolean {
  return weekdayLabels(text).size >= 3 && distinctClockTimes(text) >= 6;
}

/**
 * Worth starting the image grid reader: 6+ different ":" times. Weekday labels are checked inside it, on the
 * header read with ruling lines removed: plain OCR of a grid often misses "Mo", "Tu" between the lines.
 */
export function hasClockGrid(text: string): boolean {
  return distinctClockTimes(text) >= 6;
}

/** Highest image grid confidence: classes read from a photo are reviewed, never created on their own. */
export const IMAGE_GRID_MAX = 85;
const GRID_WIDTH = 2400;
/** PDF-like coordinates, so classesFromLayout's tolerances (in points) fit images too. */
const PAGE_WIDTH = 842;

export type OcrWord = { text: string; conf: number; x0: number; y0: number; x1: number; y1: number; line: number };

/**
 * Ruling lines (a pixel column or row dark over more than a third of the image) painted white, so the small
 * header times and labels between them can be read. `g` is a grayscale image, changed in place.
 */
export function removeRulingLines(g: Uint8Array, width: number, height: number): void {
  const dark = (v: number) => v < 170;
  for (let x = 0; x < width; x += 1) {
    let run = 0;
    let best = 0;
    for (let y = 0; y < height; y += 1) {
      run = dark(g[y * width + x]) ? run + 1 : 0;
      if (run > best) best = run;
    }
    if (best > height * 0.35) for (let y = 0; y < height; y += 1) g[y * width + x] = 255;
  }
  for (let y = 0; y < height; y += 1) {
    let run = 0;
    let best = 0;
    for (let x = 0; x < width; x += 1) {
      run = dark(g[y * width + x]) ? run + 1 : 0;
      if (run > best) best = run;
    }
    if (best > width * 0.35) g.fill(255, y * width, (y + 1) * width);
  }
}

/** Overlapping readings of the same spot (several passes): the most confident one stays. */
export function dedupeWords(words: OcrWord[]): OcrWord[] {
  const overlap = (a: OcrWord, b: OcrWord) => {
    const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (w <= 0 || h <= 0) return 0;
    return (w * h) / Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
  };
  const out: OcrWord[] = [];
  for (const w of [...words].sort((a, b) => b.conf - a.conf)) if (!out.some((o) => overlap(o, w) > 0.5)) out.push(w);
  return out;
}

/** Leftover line fragments read as "|", quotes or "¥": dropped from words; words left empty are dropped. */
export function cleanWords(words: OcrWord[]): OcrWord[] {
  return words
    .map((w) => ({ ...w, text: w.text.replace(/[|¦”“’‘"'`¥{}]/g, (c) => (c === "{" ? "(" : c === "}" ? ")" : "")).trim() }))
    // A class block's dark left bar reads as "I", "[" or "l": not text.
    .filter((w) => (/[\p{L}\p{N}]/u.test(w.text) || /^[-–]$/.test(w.text)) && !/^[\p{L}]$/u.test(w.text) && !/^[[\]Il1!]+$/.test(w.text));
}

/**
 * Words on the same visual line and close together become one item: "CSC461", "-", "G1" → "CSC461 - G1".
 * By position, not OCR line: the passes split a label across lines.
 */
export function phrases(words: OcrWord[]): OcrWord[] {
  const sameLine = (a: OcrWord, b: OcrWord) => Math.abs((a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2) < Math.min(a.y1 - a.y0, b.y1 - b.y0) * 0.6;
  const lines: OcrWord[][] = [];
  for (const w of [...words].sort((a, b) => a.y0 - b.y0)) {
    const line = lines.find((l) => sameLine(l[0], w));
    if (line) line.push(w);
    else lines.push([w]);
  }
  const out: OcrWord[] = [];
  for (const line of lines) {
    const first = out.length;
    for (const w of line.sort((a, b) => a.x0 - b.x0)) {
      const prev = out.length > first ? out[out.length - 1] : null;
      if (prev && w.x0 - prev.x1 < (w.y1 - w.y0) * 1.2) out[out.length - 1] = { ...prev, text: `${prev.text} ${w.text}`, x1: w.x1, y0: Math.min(prev.y0, w.y0), y1: Math.max(prev.y1, w.y1), conf: Math.min(prev.conf, w.conf) };
      else out.push({ ...w });
    }
  }
  // Header times stay one item per cell ("08:30"), which columns() pairs up; "CSC461-" loses the dash.
  return out.flatMap((p) => (/^\d{1,2}:\d{2}(\s+\d{1,2}:\d{2})+$/.test(p.text) ? splitTimes(p) : [{ ...p, text: p.text.replace(/^([A-Z]{2,5}\d{3}[A-Z]?)-(?=\s|$)/, "$1") }]));
}

function splitTimes(p: OcrWord): OcrWord[] {
  const parts = p.text.split(/\s+/);
  const step = (p.x1 - p.x0) / parts.length;
  return parts.map((text, i) => ({ ...p, text, x0: p.x0 + i * step, x1: p.x0 + (i + 1) * step }));
}

/**
 * Class blocks in a timetable image: solid light fills (grey, blue, orange…) that are at least `minRun` px
 * thick both ways, so thin grid lines and hatching drop out; touching blocks are split by the next block's
 * dark edge. Connected regions, as image-pixel rectangles. `rgb` is a 3-channel image.
 */
/** A class block; `inner` is where its text starts (past the dark left bar, if any). */
export type Block = Rect & { inner: number };

export function findBlocks(rgb: Uint8Array, width: number, height: number, minRun = 12): Block[] {
  const fill = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    fill[i] = lum >= 195 && Math.min(r, g, b) <= 246 ? 1 : 0; // light, but not the white page
  }
  // Keep only pixels inside long runs: horizontal first (removes vertical lines), then vertical.
  const keepRuns = (mask: Uint8Array, horizontal: boolean) => {
    const out = new Uint8Array(mask.length);
    const [outer, inner] = horizontal ? [height, width] : [width, height];
    for (let o = 0; o < outer; o += 1) {
      let start = -1;
      for (let k = 0; k <= inner; k += 1) {
        const idx = horizontal ? o * width + k : k * width + o;
        const on = k < inner && mask[idx] === 1;
        if (on && start < 0) start = k;
        if (!on && start >= 0) {
          if (k - start >= minRun) for (let j = start; j < k; j += 1) out[horizontal ? o * width + j : j * width + o] = 1;
          start = -1;
        }
      }
    }
    return out;
  };
  const solid = keepRuns(keepRuns(fill, true), false);
  const seen = new Uint8Array(width * height);
  const rects: Block[] = [];
  const stack: number[] = [];
  for (let i = 0; i < solid.length; i += 1) {
    if (!solid[i] || seen[i]) continue;
    let x1 = width;
    let y1 = height;
    let x2 = 0;
    let y2 = 0;
    let n = 0;
    seen[i] = 1;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop() as number;
      const x = p % width;
      const y = (p - x) / width;
      n += 1;
      if (x < x1) x1 = x;
      if (x > x2) x2 = x;
      if (y < y1) y1 = y;
      if (y > y2) y2 = y;
      for (const q of [p - 1, p + 1, p - width, p + width]) {
        if (q < 0 || q >= solid.length || seen[q] || !solid[q] || (Math.abs((q % width) - x) > 1)) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    // A block is mostly filled (text makes holes); big sparse regions are background tints, not blocks.
    if (n >= minRun * minRun * 4 && n >= (x2 - x1 + 1) * (y2 - y1 + 1) * 0.35) {
      const left = leftEdge(rgb, width, x1, y1 + 1);
      rects.push({ x1: left, y1, x2, y2, inner: barEnd(rgb, width, left, y1 + 1) });
    }
  }
  return rects;
}

/** First pixel right of a block's dark left bar (the block's own edge when it has none), plus a margin. */
function barEnd(rgb: Uint8Array, width: number, x: number, y: number): number {
  const dark = (cx: number) => {
    const i = (y * width + cx) * 3;
    return 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2] < 140;
  };
  let cx = x;
  while (cx < width - 1 && dark(cx)) cx += 1;
  return cx + 3;
}

/**
 * The label's dark letters break the fill, so a block seems to start after its label. From the block's top
 * row (above the text) go left to its dark left bar or the white page: that is where the block starts.
 */
function leftEdge(rgb: Uint8Array, width: number, x: number, y: number): number {
  const lum = (cx: number) => {
    const i = (y * width + cx) * 3;
    return 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2];
  };
  let edge = x;
  let whites = 0;
  for (let cx = x - 1; cx >= 0; cx -= 1) {
    const v = lum(cx);
    if (v < 110) {
      while (cx > 0 && lum(cx - 1) < 110) cx -= 1; // the block's own left bar: the block starts where it does
      return cx;
    }
    if (v > 246) {
      if ((whites += 1) >= 6) break;
      continue;
    }
    whites = 0;
    edge = cx;
  }
  return edge;
}

/**
 * Text lines of one block, read on its own: cropped from the upright original (not the thresholded page),
 * enlarged smoothly and contrast-normalised. Much cleaner than the whole page. `r` is in GRID_WIDTH pixels.
 */
async function blockLines(worker: Worker, upright: Buffer, scale: number, r: Block): Promise<string[]> {
  const left = Math.max(0, Math.round(r.inner * scale)); // past the block's dark left bar
  const top = Math.max(0, Math.round(r.y1 * scale));
  const width = Math.max(8, Math.round((r.x2 - r.inner) * scale));
  const height = Math.max(8, Math.round((r.y2 - r.y1) * scale));
  const crop = await sharp(upright)
    .extract({ left, top, width, height })
    .resize({ width: Math.round((r.x2 - r.x1) * 1.35), kernel: "lanczos3" })
    .grayscale()
    .normalise()
    .png()
    .toBuffer();
  const { data } = await worker.recognize(crop);
  return data.text
    .split(/\n+/)
    .map((l) => l.replace(/[|¦”“’‘"`¥]/g, "").replace(/\s+/g, " ").trim())
    .filter((l) => (l.match(/[\p{L}\p{N}]/gu) ?? []).length >= 2); // "D-8", "O-3" are rooms
}

/**
 * A room read from an image. "D118" / "D 8" get their hyphen ("D-118", "D-8"). The usual shapes pass: a capital,
 * hyphen and digits ("D-8", "N-25-A", "C-5") or a named lab with a code ("SE Lab-J (C-9)"). Anything else keeps
 * its text exactly as read and is flagged for checking; characters are never guessed ("p17" is not made "D-17").
 */
export function normalizeRoom(room: string | null): { room: string | null; check: boolean } {
  if (!room) return { room: null, check: false };
  const r = room.replace(/\s+/g, " ").trim();
  const bare = /^([A-Z])\s?(\d{1,3})(-[A-Z])?$/.exec(r);
  if (bare) return { room: `${bare[1]}-${bare[2]}${bare[3] ?? ""}`, check: false };
  const usual = /^[A-Z]-\d{1,3}(?:-[A-Z])?$/.test(r) || /^[A-Z][\w ]*\bLab\b[-\w ]*\([A-Z]-\d{1,3}\)$/.test(r);
  return { room: r, check: !usual };
}

/** Image coordinates (y down, pixels) → page points (y up), like a PDF text layer. */
function toPage(s: number, height: number) {
  return {
    item: (w: OcrWord): TextItem => ({ str: w.text, x: w.x0 * s, y: (height - w.y1) * s, w: (w.x1 - w.x0) * s, h: (w.y1 - w.y0) * s }),
    rect: (r: Rect): Rect => ({ x1: r.x1 * s, x2: r.x2 * s, y1: (height - r.y2) * s, y2: (height - r.y1) * s }),
  };
}

/**
 * Grid timetable in an image: class blocks found from their colour fill and read one by one; days and header
 * times read from the page with ruling lines removed (two thresholds, sparse and page mode: each finds cells
 * the others miss). Then the same layout rules as PDFs.
 */
export async function gridSchedulesFromImage(buffer: Buffer, language: string, deadline = Infinity): Promise<ExtractedSchedule[]> {
  const upright = await sharp(buffer).rotate().toBuffer();
  const originalWidth = (await sharp(upright).metadata()).width ?? GRID_WIDTH;
  const base = sharp(upright).resize({ width: GRID_WIDTH });
  const { data: gray, info } = await base.clone().grayscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const rgb = await base.clone().removeAlpha().toColourspace("srgb").raw().toBuffer();
  const clean = new Uint8Array(gray);
  removeRulingLines(clean, width, height);
  const pages = await Promise.all(
    [140, 185].map((t) => sharp(Buffer.from(clean.map((v) => (v < t ? 0 : 255))), { raw: { width, height, channels: 1 } }).png().toBuffer()),
  );
  const blocks = findBlocks(new Uint8Array(rgb), width, height);
  const words: OcrWord[] = [];
  const labelled: Array<{ rect: Block; lines: string[] }> = [];
  let timetable = false;
  await withWorker(ocrLanguages(language), async (worker) => {
    let line = 0;
    for (const page of pages) {
      for (const psm of [PSM.SPARSE_TEXT, PSM.AUTO]) {
        if (Date.now() > deadline) return;
        await worker.setParameters({ tessedit_pageseg_mode: psm, user_defined_dpi: "300" });
        const { data } = await worker.recognize(page, {}, { blocks: true });
        for (const b of data.blocks ?? []) {
          for (const p of b.paragraphs) {
            for (const l of p.lines) {
              line += 1;
              for (const w of l.words) if (w.text.trim()) words.push({ text: w.text.trim(), conf: w.confidence, line, ...w.bbox });
            }
          }
        }
        // After the first read: no weekday rows and clock headers → not a timetable; skip the rest.
        if (!timetable && !(timetable = looksLikeTimetable(words.map((w) => w.text).join("\n")))) {
          await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
          return;
        }
      }
    }
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    for (const rect of blocks) {
      if (Date.now() > deadline) break;
      const lines = await blockLines(worker, upright, originalWidth / GRID_WIDTH, rect).catch(() => []);
      if (lines.length && COURSE_RE.test(lines[0])) labelled.push({ rect, lines });
    }
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
  });
  if (!timetable) return [];
  // Days and header times from the page; each block becomes its label plus the lines under it, inside its box.
  const page = phrases(dedupeWords(cleanWords(words))).filter((w) => DAY_RE.test(w.text) || TIME_RE.test(w.text));
  const lineH = 24;
  const fromBlocks: OcrWord[] = labelled.flatMap(({ rect, lines }) =>
    lines.map((text, i) => ({ text: i ? text : text.replace(/^([A-Z]{2,5}\d{3}[A-Z]?)\s*-?\s*(G\d+)?.*$/, (_m, c: string, g?: string) => (g ? `${c} - ${g}` : c)), conf: 90, line: -1, x0: rect.x1 + 8, x1: rect.x1 + 18, y0: rect.y1 + 4 + i * lineH, y1: rect.y1 + 4 + i * lineH + lineH - 4 })),
  );
  const scale = toPage(PAGE_WIDTH / width, height);
  return classesFromLayout([...page, ...fromBlocks].map(scale.item), labelled.map((b) => scale.rect(b.rect))).map((c) => {
    const room = normalizeRoom(c.room);
    return {
      ...c,
      room: room.room,
      ...(room.check ? { roomCheck: true } : {}),
      confidence: Math.min(c.confidence, IMAGE_GRID_MAX),
      source: c.source.replace("grid", "grid photo"),
    };
  });
}

/**
 * DOC_LAYOUT: OCR words rebuilt into rows and columns ("Paper | Date | Time"), so a photographed table keeps which
 * date belongs to which paper. Phrases (words close together on a line) are cells; cells on the same visual line
 * are a row. Null when the page doesn't look like a table (fewer than 3 rows of 2+ cells): the flat text is used.
 */
export function layoutRows(words: OcrWord[]): string | null {
  const cells = phrases(dedupeWords(cleanWords(words)));
  const mid = (w: OcrWord) => (w.y0 + w.y1) / 2;
  const rows: OcrWord[][] = [];
  for (const c of [...cells].sort((a, b) => mid(a) - mid(b))) {
    const row = rows.find((r) => Math.abs(mid(r[0]) - mid(c)) < Math.min(r[0].y1 - r[0].y0, c.y1 - c.y0) * 0.6);
    if (row) row.push(c);
    else rows.push([c]);
  }
  if (rows.filter((r) => r.length >= 2).length < 3) return null;
  return rows.map((r) => r.sort((a, b) => a.x0 - b.x0).map((c) => c.text).join(" | ")).join("\n");
}
