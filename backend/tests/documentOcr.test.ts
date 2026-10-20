import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import sharp from "sharp";
import { estimateSkew, extractText, ocrLanguages, preprocessForOcr, shutdownOcr } from "../src/modules/documents/textExtraction.js";

const img = (name: string) => readFileSync(new URL(`./eval/documents/images/${name}`, import.meta.url));

test.after(() => shutdownOcr());

test("OCR languages: Urdu (and others) are read together with English", () => {
  assert.equal(ocrLanguages("eng"), "eng");
  assert.equal(ocrLanguages("urd"), "eng+urd");
  assert.equal(ocrLanguages("eng+urd"), "eng+urd");
});

test("OCR preprocessing: small photos are upscaled to at least 2000 px; a 7° tilt is found and undone", async () => {
  const meta = await sharp(await preprocessForOcr(img("table-pipe.small.png"))).metadata();
  assert.ok((meta.width ?? 0) >= 2000, `width ${meta.width}`);
  assert.equal(await estimateSkew(img("table-pipe.clean.png")), 0);
  assert.ok(Math.abs((await estimateSkew(img("table-pipe.rotate.png"))) + 7) <= 1, "rotated 7° clockwise → correct by about -7°");
});

test("OCR: a noisy photo and a scanned PDF (no text layer) are read; no 'upload photos instead' warning", async () => {
  const noisy = await extractText(img("table-pipe.noise.jpg"), "image/jpeg", "t.jpg");
  assert.match(noisy.text, /28 Oct 2026/);
  const scanned = await extractText(img("table-pipe.scanned.pdf"), "application/pdf", "t.pdf");
  assert.equal(scanned.method, "pdf-ocr");
  assert.match(scanned.text, /Assignment 1\s*\|?\s*14 Oct 2026/);
  assert.doesNotMatch(scanned.warning ?? "", /photos/);
});
