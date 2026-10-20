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
/** Images narrower than this are upscaled before OCR (Tesseract reads small text poorly). */
const MIN_OCR_WIDTH = 2000;
const MAX_OCR_WIDTH = 4000;

const workers = new Map<string, { worker: Promise<Worker>; queue: Promise<unknown> }>();

/** Anything that isn't English is read as English + that language: documents here mix both. */
export function ocrLanguages(language: string): string {
  return language === "eng" || !language ? "eng" : `eng+${language.replace(/^eng\+/, "")}`;
}

/**
 * Runs `job` on the worker for `lang`, one job at a time: the page-segmentation mode is a worker-wide
 * setting, so two uploads must not interleave their passes.
 */
function withWorker<T>(lang: string, job: (w: Worker) => Promise<T>): Promise<T> {
  let entry = workers.get(lang);
  if (!entry) {
    const worker = createWorker(lang);
    worker.catch(() => workers.delete(lang));
    entry = { worker, queue: Promise.resolve() };
    workers.set(lang, entry);
  }
  const run = entry.queue.then(async () => job(await entry.worker));
  entry.queue = run.catch(() => undefined);
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

/** Auto-rotate (EXIF) and deskew, grayscale, denoise, stretch contrast, upscale small images, sharpen. */
export async function preprocessForOcr(buffer: Buffer): Promise<Buffer> {
  const oriented = await sharp(buffer, { failOn: "none" }).rotate().flatten({ background: "#ffffff" }).grayscale().png().toBuffer();
  const skew = await estimateSkew(oriented).catch(() => 0);
  const img = sharp(oriented);
  const meta = await img.metadata();
  const width = meta.width ?? MIN_OCR_WIDTH;
  const target = Math.min(MAX_OCR_WIDTH, Math.max(width, MIN_OCR_WIDTH));
  return (skew ? img.rotate(skew, { background: "#ffffff" }) : img)
    .median(3)
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
export async function ocrImage(buffer: Buffer, language: string, budgetMs = IMAGE_BUDGET_MS): Promise<Pass> {
  const lang = ocrLanguages(language);
  const started = Date.now();
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
async function ocrScannedPdf(buffer: Buffer, language: string): Promise<TextResult> {
  const started = Date.now();
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
      const left = SCANNED_PDF_BUDGET_MS - (Date.now() - started);
      if (left <= 0) break;
      const pass = await ocrImage(Buffer.from(page.data), language, Math.min(IMAGE_BUDGET_MS, left));
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

export async function extractText(buffer: Buffer, mimeType: string, fileName: string, language = "eng"): Promise<TextResult> {
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
    if (letters < 40) return ocrScannedPdf(buffer, language); // scanned: no text layer
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
  const pass = await ocrImage(buffer, language);
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
