import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import sharp from "sharp";
import { documentDir } from "../../lib/storage.js";

/**
 * Document previews (My documents tiles and the preview screen). The original file is kept next to small JPEGs made
 * from it, in STORAGE_DIR/documents/<userId>/<documentId>/:
 *   original      the uploaded bytes (for "Open in another app")
 *   thumb.jpg     the tile image: a photo, or a PDF's first page (THUMB_WIDTH wide)
 *   page-<n>.jpg  a page made on first view (PDF page n, or the photo at PAGE_WIDTH), then reused
 * Word files and pasted text have no picture: their tile shows the type and the preview shows the text read.
 */

export const THUMB_WIDTH = 480;
export const PAGE_WIDTH = 1240;
/** Pages of a PDF that can be previewed (the rest: "Open in another app"). */
export const MAX_PREVIEW_PAGES = 50;

export type DocKind = "image" | "pdf" | "word" | "text" | "other";

export function docKind(mimeType: string, fileName: string): DocKind {
  const name = fileName.toLowerCase();
  if (mimeType.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif|gif|bmp|tiff?)$/.test(name)) return "image";
  if (mimeType === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (/wordprocessingml|msword/.test(mimeType) || /\.docx?$/.test(name)) return "word";
  if (mimeType.startsWith("text/") || name.endsWith(".txt")) return "text";
  return "other";
}

async function renderPdfPage(buffer: Buffer, page: number, width: number): Promise<{ image: Buffer | null; total: number }> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const shots = await parser.getScreenshot({ partial: [page], desiredWidth: width, imageBuffer: true, imageDataUrl: false });
    const data = shots.pages[0]?.data;
    return { image: data ? Buffer.from(data) : null, total: shots.total };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

const jpeg = (input: Buffer, width: number) =>
  sharp(input, { failOn: "none" }).rotate().resize({ width, withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();

/**
 * Saves the original and makes the tile image. Never throws: a document whose preview can't be made still uploads
 * (its tile then shows the file type).
 */
export async function storeDocumentFile(
  userId: string,
  documentId: string,
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<{ fileStored: boolean; hasThumbnail: boolean; pageCount: number | null }> {
  const dir = documentDir(userId, documentId);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "original"), buffer);
  } catch (error) {
    console.warn("Document file not stored", error instanceof Error ? error.message : error);
    return { fileStored: false, hasThumbnail: false, pageCount: null };
  }
  const kind = docKind(mimeType, fileName);
  try {
    if (kind === "image") {
      await writeFile(path.join(dir, "thumb.jpg"), await jpeg(buffer, THUMB_WIDTH));
      return { fileStored: true, hasThumbnail: true, pageCount: 1 };
    }
    if (kind === "pdf") {
      const { image, total } = await renderPdfPage(buffer, 1, THUMB_WIDTH);
      if (image) await writeFile(path.join(dir, "thumb.jpg"), await jpeg(image, THUMB_WIDTH));
      return { fileStored: true, hasThumbnail: Boolean(image), pageCount: total || null };
    }
  } catch (error) {
    console.warn("Document preview not made", error instanceof Error ? error.message : error);
  }
  return { fileStored: true, hasThumbnail: false, pageCount: null };
}

export async function readThumbnail(userId: string, documentId: string): Promise<Buffer | null> {
  return readFile(path.join(documentDir(userId, documentId), "thumb.jpg")).catch(() => null);
}

export async function readOriginal(userId: string, documentId: string): Promise<Buffer | null> {
  return readFile(path.join(documentDir(userId, documentId), "original")).catch(() => null);
}

/** One page as a JPEG (made once, then read from disk). Null: no such page or no stored file. */
export async function readPage(userId: string, doc: { id: string; mimeType: string; fileName: string; pageCount: number | null }, page: number): Promise<Buffer | null> {
  const kind = docKind(doc.mimeType, doc.fileName);
  const limit = kind === "image" ? 1 : Math.min(doc.pageCount ?? MAX_PREVIEW_PAGES, MAX_PREVIEW_PAGES);
  if ((kind !== "image" && kind !== "pdf") || !Number.isInteger(page) || page < 1 || page > limit) return null;
  const file = path.join(documentDir(userId, doc.id), `page-${page}.jpg`);
  const cached = await readFile(file).catch(() => null);
  if (cached) return cached;
  const original = await readOriginal(userId, doc.id);
  if (!original) return null;
  const image = kind === "image" ? original : (await renderPdfPage(original, page, PAGE_WIDTH)).image;
  if (!image) return null;
  const out = await jpeg(image, PAGE_WIDTH);
  await writeFile(file, out).catch(() => undefined);
  return out;
}
