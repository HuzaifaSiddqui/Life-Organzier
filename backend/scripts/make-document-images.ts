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
console.log(`Wrote ${SOURCES.length * DAMAGES.length} images and ${SCANNED.length} scanned PDFs.`);
