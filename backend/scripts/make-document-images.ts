/**
 * Generates the OCR image fixtures for `npm run eval:documents` from synthetic text fixtures (never from
 * personal files): each source is rendered as a page and saved clean plus with controlled damage.
 * Deterministic (seeded noise), so re-running produces the same files. Run: `npx tsx scripts/make-document-images.ts`.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../tests/eval/documents");
const SOURCES = ["multiline-exam", "table-pipe", "ticket-train", "syllabus-full", "table-datesheet"];
const DAMAGES = ["clean", "lowcontrast", "blur", "rotate", "noise", "small"] as const;
const WIDTH = 1400;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function page(text: string): Buffer {
  const lines = text.replace(/\t/g, "    ").split("\n");
  const lineH = 52;
  const height = 120 + lines.length * lineH;
  const body = lines.map((l, i) => `<text x="70" y="${110 + i * lineH}" xml:space="preserve">${esc(l)}</text>`).join("");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}"><rect width="100%" height="100%" fill="white"/><g font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="34" fill="#111">${body}</g></svg>`,
  );
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function damaged(svg: Buffer, damage: (typeof DAMAGES)[number], seed: number): Promise<Buffer> {
  const base = sharp(svg).flatten({ background: "#ffffff" }).grayscale();
  switch (damage) {
    case "clean":
      return base.png().toBuffer();
    case "lowcontrast":
      return base.linear(0.3, 165).png().toBuffer(); // dark grey text on light grey, like a faded print
    case "blur":
      return base.blur(2.4).png().toBuffer();
    case "rotate":
      return base.rotate(7, { background: "#ffffff" }).png().toBuffer();
    case "small":
      return base.resize({ width: 640 }).png().toBuffer(); // a low-resolution phone photo
    case "noise": {
      const { data, info } = await base.raw().toBuffer({ resolveWithObject: true });
      const rand = rng(seed);
      for (let i = 0; i < data.length; i += 1) {
        const r = rand();
        if (r < 0.04) data[i] = 0; // pepper
        else if (r < 0.08) data[i] = 255; // salt
        else data[i] = Math.max(0, Math.min(255, data[i] + Math.round((rand() - 0.5) * 70)));
      }
      // Saved as JPEG, like a phone photo (a noisy PNG is ~400 KB).
      return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).jpeg({ quality: 80 }).toBuffer();
    }
  }
}

/** A one-page PDF with only an embedded JPEG (no text layer), like a phone "scan to PDF". */
function scannedPdf(jpeg: Buffer, width: number, height: number): Buffer {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const add = (chunk: string | Buffer) => {
    const b = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk;
    parts.push(b);
    length += b.length;
  };
  const obj = (n: number, body: string | Buffer[]) => {
    offsets[n] = length;
    add(`${n} 0 obj\n`);
    if (typeof body === "string") add(body);
    else body.forEach(add);
    add("\nendobj\n");
  };
  // Page size in points: the image at 150 dpi.
  const w = Math.round((width / 150) * 72);
  const h = Math.round((height / 150) * 72);
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  add("%PDF-1.4\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  obj(4, [Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, "latin1"), jpeg, Buffer.from("\nendstream", "latin1")]);
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = length;
  add(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`);
  add(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

const SCANNED = ["table-pipe", "syllabus-full"];

/**
 * A synthetic grid timetable in the style universities export (days down the side, 30-minute slots across with
 * start/end times in 12-hour clock without am/pm, classes as coloured blocks with a dark left bar). Expected
 * classes: tests/gridImage.test.ts.
 */
export const GRID_CLASSES = [
  { day: 0, from: 0, slots: 3, label: "PHY101 - G1", lines: ["A-12"], fill: "#e3e6ec" },
  { day: 1, from: 6, slots: 3, label: "CSC201", lines: ["Lab-3"], fill: "#e3e6ec" },
  { day: 1, from: 11, slots: 2, label: "ENG110 - G2", lines: ["B-4"], fill: "#e3e6ec" },
  { day: 2, from: 3, slots: 3, label: "MTH231", lines: ["Dr Sana Ali", "C-7"], fill: "#d4f2f8" },
  { day: 2, from: 6, slots: 2, label: "CSC201", lines: ["Lab-3"], fill: "#e3e6ec" },
  { day: 3, from: 6, slots: 3, label: "CSC201", lines: ["Lab-3"], fill: "#e3e6ec" },
  { day: 4, from: 0, slots: 3, label: "MTH231", lines: ["Dr Sana Ali", "C-7"], fill: "#d4f2f8" },
  { day: 5, from: 3, slots: 6, label: "CSE499", lines: ["FYP Lab"], fill: "#fbe8d2" },
];

function gridTimetable(): Buffer {
  const days = ["Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const left = 70;
  const colW = 58;
  const top = 110;
  const headH = 64;
  const rowH = 96;
  const slots = 22;
  const width = left + slots * colW + 10;
  const height = top + headH + days.length * rowH + 10;
  const clock = (m: number) => `${String(((Math.floor(m / 60) + 11) % 12) + 1).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const parts: string[] = [`<rect width="100%" height="100%" fill="white"/>`, `<text x="${width / 2}" y="40" font-size="26" text-anchor="middle">Spring 2027 Timetable</text>`];
  for (let c = 0; c <= slots; c += 1) parts.push(`<line x1="${left + c * colW}" y1="${top}" x2="${left + c * colW}" y2="${height - 10}" stroke="#555" stroke-width="1.5"/>`);
  for (const y of [top, top + headH, ...days.map((_, r) => top + headH + (r + 1) * rowH)]) parts.push(`<line x1="10" y1="${y}" x2="${width - 10}" y2="${y}" stroke="#555" stroke-width="1.5"/>`);
  for (let c = 0; c < slots; c += 1) {
    const start = 8 * 60 + 30 + c * 30;
    const cx = left + c * colW + colW / 2;
    parts.push(`<text x="${cx}" y="${top + 18}" font-size="14" text-anchor="middle">${c + 1}</text>`);
    parts.push(`<text x="${cx}" y="${top + 38}" font-size="14" text-anchor="middle">${clock(start)}</text>`);
    parts.push(`<text x="${cx}" y="${top + 56}" font-size="14" text-anchor="middle">${clock(start + 30)}</text>`);
  }
  days.forEach((d, r) => parts.push(`<text x="40" y="${top + headH + r * rowH + rowH / 2 + 10}" font-size="26" font-weight="bold" text-anchor="middle">${d}</text>`));
  for (const k of GRID_CLASSES) {
    const x = left + k.from * colW + 1;
    const y = top + headH + k.day * rowH + 4;
    const w = k.slots * colW - 2;
    const h = rowH - 8;
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${k.fill}" stroke="#9aa0a6" stroke-width="1"/>`);
    parts.push(`<rect x="${x}" y="${y}" width="6" height="${h}" fill="#2c3e50"/>`);
    parts.push(`<text x="${x + 14}" y="${y + 22}" font-size="16" font-weight="bold">${esc(k.label)}</text>`);
    k.lines.forEach((l, i) => parts.push(`<text x="${x + 14}" y="${y + 46 + i * 22}" font-size="14">${esc(l)}</text>`));
  }
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g font-family="DejaVu Sans, Arial, Helvetica, sans-serif" fill="#111">${parts.join("")}</g></svg>`);
}

if (process.argv.includes("--grid-only")) {
  writeFileSync(join(dir, "images", "timetable-grid.png"), await sharp(gridTimetable()).flatten({ background: "#ffffff" }).png().toBuffer());
  console.log("Wrote images/timetable-grid.png");
  process.exit(0);
}

const manifestPath = join(dir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { documents: Array<Record<string, unknown>> };
manifest.documents = manifest.documents.filter((d) => !d.from); // regenerate image rows
mkdirSync(join(dir, "images"), { recursive: true });
let seed = 1;
for (const name of SOURCES) {
  const svg = page(readFileSync(join(dir, "fixtures", `${name}.txt`), "utf8").trimEnd());
  const source = manifest.documents.find((d) => d.file === `fixtures/${name}.txt`);
  if (!source) throw new Error(`no manifest row for ${name}`);
  for (const damage of DAMAGES) {
    const file = `images/${name}.${damage}.${damage === "noise" ? "jpg" : "png"}`;
    writeFileSync(join(dir, file), await damaged(svg, damage, seed++));
    manifest.documents.push({ file, from: name, docType: source.docType, categories: ["image", damage] });
  }
}
for (const name of SCANNED) {
  const svg = page(readFileSync(join(dir, "fixtures", `${name}.txt`), "utf8").trimEnd());
  const { data, info } = await sharp(svg).flatten({ background: "#ffffff" }).grayscale().jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
  const source = manifest.documents.find((d) => d.file === `fixtures/${name}.txt`);
  const file = `images/${name}.scanned.pdf`;
  writeFileSync(join(dir, file), scannedPdf(data, info.width, info.height));
  manifest.documents.push({ file, from: name, docType: source?.docType, categories: ["image", "scanned-pdf"] });
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(dir, "images", "timetable-grid.png"), await sharp(gridTimetable()).flatten({ background: "#ffffff" }).png().toBuffer());
console.log(`Wrote ${SOURCES.length * DAMAGES.length} images, ${SCANNED.length} scanned PDFs and the grid timetable.`);
