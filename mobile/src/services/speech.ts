import * as Speech from "expo-speech";

const LANG: Record<string, string> = {
  en: "en-US",
  ur: "ur-PK",
  ar: "ar-SA",
  es: "es-ES",
  fr: "fr-FR",
  zh: "zh-CN",
  hi: "hi-IN",
};

function plain(text: string): string {
  return text
    .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{27BF}\u{2B00}-\u{2BFF}\u{2580}-\u{259F}\u{FE0F}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Text-to-speech read-back (FR-VF-002) using the user's language and speed. */
export function speak(text: string, opts: { language?: string; rate?: number } = {}): void {
  const clean = plain(text);
  if (!clean) return;
  try {
    Speech.stop();
    Speech.speak(clean, { language: LANG[opts.language ?? "en"] ?? "en-US", rate: opts.rate ?? 1 });
  } catch {
    // TTS unavailable (e.g. no native module in Expo Go) — silently skip.
  }
}

export function stopSpeaking(): void {
  try {
    void Speech.stop();
  } catch {
    // ignore
  }
}
