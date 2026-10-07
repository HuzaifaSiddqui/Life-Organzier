import { RoutineFrequency } from "@prisma/client";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { formatClockFromMinutes } from "../../lib/time.js";
import type { ExtractedSchedule } from "./extraction.js";

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
  return raw.map((c, i) => {
    const half = ((raw[i + 1]?.cx ?? c.cx + (c.cx - raw[i - 1].cx)) - c.cx) / 2;
    return { left: c.cx - half, right: c.cx + half, start: c.start, end: c.end };
  });
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
