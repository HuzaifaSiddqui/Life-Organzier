import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

// Files go to a temporary folder, not backend/storage.
process.env.STORAGE_DIR = mkdtempSync(path.join(tmpdir(), "lo-docs-"));

const { docKind, readOriginal, readPage, readThumbnail, storeDocumentFile, THUMB_WIDTH, PAGE_WIDTH } = await import("../src/modules/documents/documentFiles.js");
const { documentDir, removeDocumentFiles, removeUserFiles } = await import("../src/lib/storage.js");

/** Document previews: the original is kept with a tile image; pages are made on first view; deleting removes them. */

const PDF = readFileSync(path.join(import.meta.dirname, "eval/documents/images/table-pipe.scanned.pdf"));

test("kinds from the type or the name", () => {
  assert.equal(docKind("image/jpeg", "a.jpg"), "image");
  assert.equal(docKind("application/octet-stream", "Scan.HEIC"), "image");
  assert.equal(docKind("application/pdf", "x"), "pdf");
  assert.equal(docKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx"), "word");
  assert.equal(docKind("text/plain", "notes"), "text");
  assert.equal(docKind("application/zip", "a.zip"), "other");
});

test("a photo: kept, a small tile and one full page", async () => {
  const user = randomUUID();
  const id = randomUUID();
  const photo = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#cc8833" } }).jpeg().toBuffer();
  const r = await storeDocumentFile(user, id, photo, "image/jpeg", "board.jpg");
  assert.deepEqual(r, { fileStored: true, hasThumbnail: true, pageCount: 1 });
  assert.deepEqual(await readOriginal(user, id), photo);
  assert.equal((await sharp((await readThumbnail(user, id))!).metadata()).width, THUMB_WIDTH);
  const page = await readPage(user, { id, mimeType: "image/jpeg", fileName: "board.jpg", pageCount: 1 }, 1);
  assert.equal((await sharp(page!).metadata()).width, PAGE_WIDTH);
  assert.equal(await readPage(user, { id, mimeType: "image/jpeg", fileName: "board.jpg", pageCount: 1 }, 2), null);
  await removeDocumentFiles(user, id);
  assert.equal(existsSync(documentDir(user, id)), false);
});

test("a PDF: first page as the tile, the page count, pages rendered once and cached", async () => {
  const user = randomUUID();
  const id = randomUUID();
  const r = await storeDocumentFile(user, id, PDF, "application/pdf", "timetable.pdf");
  assert.equal(r.fileStored, true);
  assert.equal(r.hasThumbnail, true);
  assert.ok((r.pageCount ?? 0) >= 1);
  const meta = await sharp((await readThumbnail(user, id))!).metadata();
  assert.deepEqual([meta.format, meta.width], ["jpeg", THUMB_WIDTH]);
  const doc = { id, mimeType: "application/pdf", fileName: "timetable.pdf", pageCount: r.pageCount };
  const page1 = await readPage(user, doc, 1);
  assert.ok(page1 && page1.length > 1000);
  assert.ok(existsSync(path.join(documentDir(user, id), "page-1.jpg")), "cached for the next view");
  assert.equal(await readPage(user, doc, (r.pageCount ?? 1) + 1), null, "past the last page");
  assert.equal(await readPage(user, doc, 0), null);
  await removeUserFiles(user);
  assert.equal(existsSync(documentDir(user, id)), false);
});

test("a broken file still uploads: stored, no tile; Word files have no tile", async () => {
  const user = randomUUID();
  const broken = await storeDocumentFile(user, randomUUID(), Buffer.from("%PDF-1.4 not really"), "application/pdf", "broken.pdf");
  assert.deepEqual(broken, { fileStored: true, hasThumbnail: false, pageCount: null });
  const word = await storeDocumentFile(user, randomUUID(), Buffer.from("PK..."), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx");
  assert.deepEqual(word, { fileStored: true, hasThumbnail: false, pageCount: null });
  await removeUserFiles(user);
});
