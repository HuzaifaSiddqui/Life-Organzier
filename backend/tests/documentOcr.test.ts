import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import sharp from "sharp";
import { estimateSkew, extractText, MAX_OCR_WAITING, MIN_OCR_START_MS, OcrBusyError, ocrImage, ocrLanguages, preprocessForOcr, shutdownOcr, withWorker } from "../src/modules/documents/textExtraction.js";

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

test("OCR queue: one job runs, at most MAX_OCR_WAITING wait, the next is refused as busy (not queued)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const isRunning = new Promise<void>((r) => (started = r));
  const running = withWorker("eng", async () => {
    started();
    await gate;
  });
  await isRunning; // it counts as waiting until the worker has started it
  const waiting = Array.from({ length: MAX_OCR_WAITING }, () => withWorker("eng", async () => "done"));
  await assert.rejects(withWorker("eng", async () => "too many"), OcrBusyError);
  release();
  await running;
  assert.deepEqual(await Promise.all(waiting), Array(MAX_OCR_WAITING).fill("done"));
  assert.equal(await withWorker("eng", async () => "room again"), "room again");
});

test("OCR deadline: time waiting in the queue counts; a job that would start too late is refused, not run past the limit", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const isRunning = new Promise<void>((r) => (started = r));
  const blocker = withWorker("eng", async () => {
    started();
    await gate;
  });
  await isRunning;
  // Queued behind the blocker with a deadline that passes while it waits.
  const late = ocrImage(img("table-pipe.clean.png"), "eng", 45000, Date.now() + MIN_OCR_START_MS + 200);
  await new Promise((r) => setTimeout(r, 400)); // the blocker holds the worker past that deadline
  release();
  await blocker;
  await assert.rejects(late, OcrBusyError);
  // No deadline: the same image is read normally.
  assert.match((await ocrImage(img("table-pipe.clean.png"), "eng")).text, /Assignment 1/);
});
