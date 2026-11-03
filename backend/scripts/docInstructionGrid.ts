import sharp from "sharp";

/** A grid timetable like the ones universities export, the teacher's name inside each class box. */
export function gridImage(): Promise<Buffer> {
  // The positions of the repo's own grid fixture (scripts/make-document-images.ts → GRID_CLASSES), which the grid
  // reader is known to read; only the names in the boxes change. Two teachers share a first name.
  const classes = [
    { day: 0, from: 0, slots: 3, label: "CS201", lines: ["Dr Ahmed Khan", "A-12"] },
    { day: 1, from: 6, slots: 3, label: "CS301", lines: ["Dr Ahmed Raza", "Lab-3"] },
    { day: 1, from: 11, slots: 2, label: "EN102", lines: ["Ms Sara Malik", "B-4"] },
    { day: 2, from: 3, slots: 3, label: "CS201", lines: ["Dr Ahmed Khan", "C-7"] },
    { day: 2, from: 6, slots: 2, label: "CS301", lines: ["Dr Ahmed Raza", "Lab-3"] },
    { day: 3, from: 6, slots: 3, label: "CS301", lines: ["Dr Ahmed Raza", "Lab-3"] },
    { day: 4, from: 0, slots: 3, label: "CS201", lines: ["Dr Ahmed Khan", "C-7"] },
    { day: 5, from: 3, slots: 6, label: "EN102", lines: ["Ms Sara Malik", "FYP Lab"] },
  ];
  const days = ["Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const [left, colW, top, headH, rowH, slots] = [70, 58, 110, 64, 96, 22];
  const width = left + slots * colW + 10;
  const height = top + headH + days.length * rowH + 10;
  const clock = (m: number) => `${String(((Math.floor(m / 60) + 11) % 12) + 1).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const p: string[] = [`<rect width="100%" height="100%" fill="white"/>`, `<text x="${width / 2}" y="40" font-size="26" text-anchor="middle">Spring 2027 Timetable</text>`];
  for (let c = 0; c <= slots; c += 1) p.push(`<line x1="${left + c * colW}" y1="${top}" x2="${left + c * colW}" y2="${height - 10}" stroke="#555" stroke-width="1.5"/>`);
  for (const y of [top, top + headH, ...days.map((_, r) => top + headH + (r + 1) * rowH)]) p.push(`<line x1="10" y1="${y}" x2="${width - 10}" y2="${y}" stroke="#555" stroke-width="1.5"/>`);
  for (let c = 0; c < slots; c += 1) {
    const start = 8 * 60 + 30 + c * 30;
    const cx = left + c * colW + colW / 2;
    p.push(`<text x="${cx}" y="${top + 18}" font-size="14" text-anchor="middle">${c + 1}</text><text x="${cx}" y="${top + 38}" font-size="14" text-anchor="middle">${clock(start)}</text><text x="${cx}" y="${top + 56}" font-size="14" text-anchor="middle">${clock(start + 30)}</text>`);
  }
  days.forEach((d, r) => p.push(`<text x="40" y="${top + headH + r * rowH + rowH / 2 + 10}" font-size="26" font-weight="bold" text-anchor="middle">${d}</text>`));
  for (const k of classes) {
    const x = left + k.from * colW + 1;
    const y = top + headH + k.day * rowH + 4;
    p.push(`<rect x="${x}" y="${y}" width="${k.slots * colW - 2}" height="${rowH - 8}" fill="#e3e6ec" stroke="#9aa0a6"/><rect x="${x}" y="${y}" width="6" height="${rowH - 8}" fill="#2c3e50"/>`);
    p.push(`<text x="${x + 14}" y="${y + 22}" font-size="16" font-weight="bold">${k.label}</text>`);
    k.lines.forEach((l, i) => p.push(`<text x="${x + 14}" y="${y + 46 + i * 22}" font-size="14">${l}</text>`));
  }
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g font-family="DejaVu Sans, Arial, Helvetica, sans-serif" fill="#111">${p.join("")}</g></svg>`)).flatten({ background: "#ffffff" }).png().toBuffer();
}

