import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { createWorker, type Worker } from "tesseract.js";

export type TextResult = {
  text: string;
  /** 0–100; native PDF/DOCX text is treated as 100. */
  confidence: number;
  method: "pdf" | "docx" | "ocr" | "text";
  warning: string | null;
  needsLanguage: boolean;
};

const workers = new Map<string, Promise<Worker>>();

function ocrWorker(lang: string): Promise<Worker> {
  let w = workers.get(lang);
  if (!w) {
    w = createWorker(lang);
    w.catch(() => workers.delete(lang));
    workers.set(lang, w);
  }
  return w;
}

export const SUPPORTED_MIME = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
  "image/jpg",
  "text/plain",
];

export async function extractText(buffer: Buffer, mimeType: string, fileName: string, language = "eng"): Promise<TextResult> {
  const lower = fileName.toLowerCase();
  if (mimeType === "application/pdf" || lower.endsWith(".pdf")) {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      const text = result.text ?? "";
      const letters = (text.match(/[A-Za-z؀-ۿ]/g) ?? []).length;
      if (letters < 40) {
        return {
          text,
          confidence: 20,
          method: "pdf",
          warning: "This PDF looks scanned (no text layer). Upload photos of the pages as JPG/PNG so I can read them with OCR.",
          needsLanguage: false,
        };
      }
      return { text, confidence: 100, method: "pdf", warning: null, needsLanguage: false };
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }
  if (mimeType.includes("wordprocessingml") || lower.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value, confidence: 100, method: "docx", warning: null, needsLanguage: false };
  }
  if (mimeType.startsWith("text/") || lower.endsWith(".txt")) {
    return { text: buffer.toString("utf8"), confidence: 100, method: "text", warning: null, needsLanguage: false };
  }
  // Images → Tesseract OCR (FR-DP-001 §3)
  const worker = await ocrWorker(language);
  const { data } = await worker.recognize(buffer);
  const confidence = Math.round(data.confidence ?? 0);
  const latin = (data.text.match(/[A-Za-z]/g) ?? []).length;
  const needsLanguage = language === "eng" && confidence < 55 && latin < 30;
  return {
    text: data.text,
    confidence,
    method: "ocr",
    warning: needsLanguage
      ? "I couldn't read this clearly. Is it in Urdu or another language?"
      : confidence < 70
        ? "Quality is low, so results may be incomplete. Try uploading a clearer image?"
        : null,
    needsLanguage,
  };
}

export async function shutdownOcr(): Promise<void> {
  for (const w of workers.values()) {
    try {
      await (await w).terminate();
    } catch {
      // ignore
    }
  }
  workers.clear();
}
