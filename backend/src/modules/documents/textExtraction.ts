import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import sharp from "sharp";
import { createWorker, PSM, type Worker } from "tesseract.js";

export type TextResult = {
  text: string;
  /** 0–100; native PDF/DOCX text is treated as 100. */
  confidence: number;
  method: "pdf" | "pdf-ocr" | "docx" | "ocr" | "text";
  warning: string | null;
  needsLanguage: boolean;
};

/** Scanned PDFs: pages read with OCR, and the time allowed for all of them. */
export const MAX_SCANNED_PAGES = 10;
const SCANNED_PDF_BUDGET_MS = 90_000;
/** One image: all OCR passes together. */
const IMAGE_BUDGET_MS = 45_000;
/** A job that reaches the front of the queue with less time than this before its document's deadline is refused. */
export const MIN_OCR_START_MS = 8_000;
/** Images narrower than this are upscaled before OCR (Tesseract reads small text poorly). */
const MIN_OCR_WIDTH = 2000;
/**
 * Wider images are scaled down to this. Measured on the noisiest fixture (Apple M1): the longest single pass took
 * 0.46 s at 2500 px, 0.54 s at 3000 px but 17–53 s at 4000 px, and a pass can't be interrupted, so a 12 MP phone
 * photo (≈4000 px) could overrun the time limit by most of a minute. 2500 px still gives letters plenty of pixels.
 */
export const MAX_OCR_WIDTH = 2500;

const workers = new Map<string, { worker: Promise<Worker>; queue: Promise<unknown>; waiting: number }>();

/** OCR jobs allowed to wait per language (one runs at a time). More are refused with OcrBusyError. */
export const MAX_OCR_WAITING = 3;

/** The OCR queue is full: the caller answers "busy, try again in a minute" instead of piling up work. */
export class OcrBusyError extends Error {
  constructor() {
    super("OCR is busy");
    this.name = "OcrBusyError";
  }
}

/** Anything that isn't English is read as English + that language: documents here mix both. */
export function ocrLanguages(language: string): string {
  return language === "eng" || !language ? "eng" : `eng+${language.replace(/^eng\+/, "")}`;
}

/**
 * Runs `job` on the worker for `lang`, one job at a time: the page-segmentation mode is a worker-wide
 * setting, so two uploads must not interleave their passes.
 */
export function withWorker<T>(lang: string, job: (w: Worker) => Promise<T>): Promise<T> {
  let entry = workers.get(lang);
  if (!entry) {
    const worker = createWorker(lang);
    worker.catch(() => workers.delete(lang));
    entry = { worker, queue: Promise.resolve(), waiting: 0 };
    workers.set(lang, entry);
  }
  if (entry.waiting >= MAX_OCR_WAITING) return Promise.reject(new OcrBusyError());
  const e = entry;
  e.waiting += 1;
  const run = e.queue.then(async () => {
    e.waiting -= 1;
    return job(await e.worker);
  });
  e.queue = run.catch(() => undefined);
  return run;
}

export const SUPPORTED_MIME = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
  "image/jpg",
  "text/plain",
];

/**
 * Skew of a photographed page, in degrees (±10): the angle at which the rows of text line up best, i.e. the
 * row-darkness profile of a small binarised copy varies the most. Cheap (a 500 px copy per angle).
 */
export async function estimateSkew(image: Buffer): Promise<number> {
  const small = await sharp(image, { failOn: "none" }).grayscale().resize({ width: 500 }).threshold(160).png().toBuffer();
  let best = { angle: 0, score: -1 };
  for (let angle = -10; angle <= 10; angle += 1) {
    const { data, info } = await sharp(small).rotate(angle, { background: "#ffffff" }).raw().toBuffer({ resolveWithObject: true });
    const rows: number[] = [];
    for (let y = 0; y < info.height; y += 1) {
      let dark = 0;
      for (let x = 0; x < info.width; x += 1) if (data[(y * info.width + x) * info.channels] < 128) dark += 1;
      rows.push(dark);
    }
    const mean = rows.reduce((a, b) => a + b, 0) / rows.length;
    const score = rows.reduce((a, b) => a + (b - mean) ** 2, 0) / rows.length;
    if (score > best.score) best = { angle, score };
  }
  return best.angle;
}

/** Auto-rotate (EXIF) and deskew, grayscale, denoise, stretch contrast, upscale small images, sharpen. `strong`: heavier denoise for grainy photos. */
export async function preprocessForOcr(buffer: Buffer, strong = false): Promise<Buffer> {
  const oriented = await sharp(buffer, { failOn: "none" }).rotate().flatten({ background: "#ffffff" }).grayscale().png().toBuffer();
  const skew = await estimateSkew(oriented).catch(() => 0);
  const img = sharp(oriented);
  const meta = await img.metadata();
  const width = meta.width ?? MIN_OCR_WIDTH;
  const target = Math.min(MAX_OCR_WIDTH, Math.max(width, MIN_OCR_WIDTH));
  return (skew ? img.rotate(skew, { background: "#ffffff" }) : img)
    .median(strong ? 5 : 3)
    .normalise()
    .resize({ width: target, kernel: "lanczos3" })
    .sharpen({ sigma: 1 })
    .png()
    .toBuffer();
}

type Pass = { text: string; confidence: number; label: string };

/**
 * OCR with a few variants, keeping the most confident: the preprocessed image with three page-segmentation
 * modes (whole page, one block, sparse text such as tables and tickets), and the raw image as a fallback in
 * case preprocessing made it worse. Stops early when time runs out or a pass is already very confident.
 */
/**
 * `deadline` (epoch ms): the whole document's limit. Time spent waiting in the queue counts against it: when the
 * job finally starts with less than MIN_OCR_START_MS left, it is refused as busy instead of running past the limit.
 * The image's own budget counts from when the job starts (not from the queue), capped by the deadline.
 */
export async function ocrImage(buffer: Buffer, language: string, budgetMs = IMAGE_BUDGET_MS, deadline = Infinity): Promise<Pass> {
  const lang = ocrLanguages(language);
  const prepared = await preprocessForOcr(buffer).catch(() => null);
  const plan: Array<{ image: Buffer; psm: PSM; label: string }> = [
    ...(prepared
      ? [
          { image: prepared, psm: PSM.AUTO, label: "prep/auto" },
          { image: prepared, psm: PSM.SINGLE_BLOCK, label: "prep/block" },
          { image: prepared, psm: PSM.SPARSE_TEXT, label: "prep/sparse" },
        ]
      : []),
    { image: buffer, psm: PSM.AUTO, label: "raw/auto" },
    { image: buffer, psm: PSM.SPARSE_TEXT, label: "raw/sparse" },
  ];
  return withWorker(lang, async (worker) => {
    const started = Date.now();
    if (deadline - started < MIN_OCR_START_MS) throw new OcrBusyError(); // waited too long in the queue
    budgetMs = Math.min(budgetMs, deadline - started);
    let best: Pass = { text: "", confidence: -1, label: "none" };
    for (const step of plan) {
      if (best.confidence >= 0 && Date.now() - started > budgetMs) break;
      await worker.setParameters({ tessedit_pageseg_mode: step.psm });
      const { data } = await worker.recognize(step.image);
      // A pass that read (almost) nothing can still report high confidence: it only competes when all did.
      const readable = (data.text.match(/[\p{L}\p{N}]/gu) ?? []).length >= 15;
      const confidence = readable ? Math.round(data.confidence ?? 0) : 0;
      if (confidence > best.confidence || (confidence === best.confidence && data.text.length > best.text.length)) best = { text: data.text, confidence, label: step.label };
      if (best.confidence >= 92) break;
    }
    // Still unsure (grainy photo): a heavier denoise, read as a page and as sparse text.
    if (best.confidence < 85 && Date.now() - started < budgetMs) {
      const strong = await preprocessForOcr(buffer, true).catch(() => null);
      for (const psm of strong ? [PSM.AUTO, PSM.SPARSE_TEXT] : []) {
        if (Date.now() - started > budgetMs) break;
        await worker.setParameters({ tessedit_pageseg_mode: psm });
        const { data } = await worker.recognize(strong as Buffer);
        const readable = (data.text.match(/[\p{L}\p{N}]/gu) ?? []).length >= 15;
        const confidence = readable ? Math.round(data.confidence ?? 0) : 0;
        if (confidence > best.confidence) best = { text: data.text, confidence, label: `strong/${psm}` };
      }
    }
    return best;
  });
}

function ocrResult(text: string, confidence: number, language: string, method: "ocr" | "pdf-ocr", extraWarning: string | null = null): TextResult {
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const needsLanguage = language === "eng" && confidence < 55 && latin < 30;
  return {
    text,
    confidence,
    method,
    warning: needsLanguage
      ? "I couldn't read this clearly. Is it in Urdu or another language?"
      : confidence < 70
        ? "Quality is low, so results may be incomplete. Try uploading a clearer image?"
        : extraWarning,
    needsLanguage,
  };
}

/** A PDF without a text layer: render the first pages on the server and OCR them. */
async function ocrScannedPdf(buffer: Buffer, language: string, deadline = Infinity): Promise<TextResult> {
  const started = Date.now();
  const end = Math.min(started + SCANNED_PDF_BUDGET_MS, deadline);
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const info = await parser.getInfo().catch(() => null);
    const total = info?.total ?? 0;
    const shots = await Promise.race([
      parser.getScreenshot({ first: MAX_SCANNED_PAGES, desiredWidth: MIN_OCR_WIDTH, imageBuffer: true, imageDataUrl: false }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SCANNED_PDF_BUDGET_MS / 3)),
    ]);
    if (!shots?.pages.length) return { text: "", confidence: 0, method: "pdf-ocr", warning: "I couldn't read this scanned PDF. Try uploading photos of the pages instead.", needsLanguage: false };
    const texts: string[] = [];
    const confidences: number[] = [];
    for (const page of shots.pages) {
      if (end - Date.now() <= 0) break;
      // Each page queues again; one that would start too late ends the PDF with the pages read so far.
      const pass = await ocrImage(Buffer.from(page.data), language, IMAGE_BUDGET_MS, end).catch((error: unknown) => {
        if (error instanceof OcrBusyError && texts.length) return null;
        throw error;
      });
      if (!pass) break;
      texts.push(pass.text);
      confidences.push(pass.confidence);
    }
    const read = texts.length;
    const confidence = Math.round(confidences.reduce((s, c) => s + c, 0) / Math.max(1, read));
    const skipped = Math.max(total, shots.pages.length) - read;
    const warning = skipped > 0 ? `I read the first ${read} page${read === 1 ? "" : "s"} of this scanned PDF; the other ${skipped} were skipped.` : null;
    return ocrResult(texts.join("\n\n"), confidence, language, "pdf-ocr", warning);
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/** `deadline` (epoch ms): the document's time limit; OCR doesn't start a job that would run past it. */
export async function extractText(buffer: Buffer, mimeType: string, fileName: string, language = "eng", deadline = Infinity): Promise<TextResult> {
  const lower = fileName.toLowerCase();
  if (mimeType === "application/pdf" || lower.endsWith(".pdf")) {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    let text = "";
    try {
      text = (await parser.getText()).text ?? "";
    } finally {
      await parser.destroy().catch(() => undefined);
    }
    const letters = (text.match(/[A-Za-z؀-ۿ]/g) ?? []).length;
    if (letters < 40) return ocrScannedPdf(buffer, language, deadline); // scanned: no text layer
    return { text, confidence: 100, method: "pdf", warning: null, needsLanguage: false };
  }
  if (mimeType.includes("wordprocessingml") || lower.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value, confidence: 100, method: "docx", warning: null, needsLanguage: false };
  }
  if (mimeType.startsWith("text/") || lower.endsWith(".txt")) {
    return { text: buffer.toString("utf8"), confidence: 100, method: "text", warning: null, needsLanguage: false };
  }
  // Images → Tesseract OCR (FR-DP-001 §3)
  const pass = await ocrImage(buffer, language, IMAGE_BUDGET_MS, deadline);
  return ocrResult(pass.text, pass.confidence, language, "ocr");
}

export async function shutdownOcr(): Promise<void> {
  for (const entry of workers.values()) {
    try {
      await (await entry.worker).terminate();
    } catch {
      // ignore
    }
  }
  workers.clear();
}
