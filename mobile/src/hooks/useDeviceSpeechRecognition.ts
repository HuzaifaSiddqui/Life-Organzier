import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ExpoSpeechRecognitionErrorEvent,
  ExpoSpeechRecognitionResultEvent,
} from "expo-speech-recognition";
import {
  getNativeSpeechModule,
  isNativeSpeechRecognitionAvailable,
} from "../native/getNativeSpeechModule";

export type DeviceSpeechRecognitionOptions = {
  /** Called with full text (existing draft prefix + recognized speech) on each update. */
  onTranscriptChange?: (fullText: string) => void;
  /** Fires when recognition stops; includes final merged text and transcript confidence (0–1, or -1 if unknown). */
  onRecognitionEnd?: (fullText: string, confidence: number) => void;
  onError?: (message: string) => void;
};

/**
 * On-device speech-to-text via expo-speech-recognition (iOS/Android), only after a dev/native build.
 * Does not load the native module in Expo Go (avoids crash).
 */
export function useDeviceSpeechRecognition(options: DeviceSpeechRecognitionOptions = {}) {
  const optsRef = useRef(options);
  optsRef.current = options;

  const [listening, setListening] = useState(false);

  const prefixRef = useRef("");
  const lastTranscriptRef = useRef("");
  const receivedResultRef = useRef(false);
  const confidenceRef = useRef(-1);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Hold-to-talk: finished phrases so far (continuous recognition sends one final result per phrase). */
  const holdRef = useRef(false);
  const committedRef = useRef("");
  const join = (...parts: string[]) => parts.filter((p) => p.trim()).join(" ");

  useEffect(() => {
    const mod = getNativeSpeechModule();
    if (!mod) return;

    const onStart = () => {
      setListening(true);
      lastTranscriptRef.current = "";
      receivedResultRef.current = false;
    };

    const onResult = (event: unknown) => {
      const e = event as ExpoSpeechRecognitionResultEvent;
      const t = e.results[0]?.transcript ?? "";
      const c = e.results[0]?.confidence;
      if (e.isFinal && typeof c === "number") confidenceRef.current = c;
      if (t.trim().length > 0) receivedResultRef.current = true;
      if (holdRef.current && e.isFinal) {
        committedRef.current = join(committedRef.current, t);
        lastTranscriptRef.current = "";
      } else {
        lastTranscriptRef.current = t;
      }
      const full = join(prefixRef.current, committedRef.current, lastTranscriptRef.current);
      optsRef.current.onTranscriptChange?.(full);
    };

    const onErr = (event: unknown) => {
      setListening(false);
      const e = event as ExpoSpeechRecognitionErrorEvent;
      if (e.error === "no-speech") {
        // This is common when users pause too long or emulator mic is not routed.
        // If we already got partial text, don't surface it as a blocking error.
        if (receivedResultRef.current) return;
        optsRef.current.onError?.(
          "No speech detected. Speak immediately after tapping mic, and make sure device/emulator microphone is enabled."
        );
        return;
      }
      const msg =
        typeof e.message === "string" && e.message.length > 0
          ? e.message
          : `Speech recognition error (${String(e.error)})`;
      optsRef.current.onError?.(msg);
    };

    const onEnd = () => {
      setListening(false);
      if (maxTimerRef.current) {
        clearTimeout(maxTimerRef.current);
        maxTimerRef.current = null;
      }
      const full = join(prefixRef.current, committedRef.current, lastTranscriptRef.current);
      optsRef.current.onRecognitionEnd?.(full, confidenceRef.current);
    };

    const s1 = mod.addListener("start", onStart);
    const s2 = mod.addListener("result", onResult);
    const s3 = mod.addListener("error", onErr);
    const s4 = mod.addListener("end", onEnd);

    return () => {
      s1.remove();
      s2.remove();
      s3.remove();
      s4.remove();
    };
  }, []);

  useEffect(() => {
    return () => {
      try {
        getNativeSpeechModule()?.abort();
      } catch {
        // ignore
      }
    };
  }, []);

  /**
   * `hints`: words from the user's data the recogniser should expect (task titles, places, course codes).
   * `hold`: hold-to-talk (the ✦ button): keeps listening through pauses until `stop()` (the finger lifts), instead of
   * the tap-to-talk rule (FR-VF-001) of stopping after 2 s of silence.
   */
  const start = useCallback(async (existingText: string, lang = "en-US", hints: string[] = [], opts: { hold?: boolean } = {}) => {
    const mod = getNativeSpeechModule();
    if (!mod) {
      optsRef.current.onError?.(
        "Voice input isn't available here. Type your message instead."
      );
      return false;
    }

    prefixRef.current = existingText;
    holdRef.current = Boolean(opts.hold);
    committedRef.current = "";
    lastTranscriptRef.current = "";
    receivedResultRef.current = false;
    confidenceRef.current = -1;

    const perm = await mod.requestPermissionsAsync();
    if (!perm.granted) {
      optsRef.current.onError?.(
        "Microphone or speech recognition permission was denied. Enable it in Settings."
      );
      return false;
    }

    mod.start({
      lang,
      interimResults: true,
      // Android 13+ / iOS keep listening through pauses; older Android ends and the caller restarts while held.
      continuous: Boolean(opts.hold),
      iosTaskHint: "dictation",
      // Android 13+ (EXTRA_BIASING_STRINGS) and iOS (SFSpeechRecognitionRequest.contextualStrings); older Android ignores it.
      ...(hints.length ? { contextualStrings: hints } : {}),
      androidIntentOptions: {
        // FR-VF-001: auto-stop after 2+ seconds of silence (tap to talk); while held, the finger decides.
        EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: opts.hold ? 20000 : 2000,
        EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: opts.hold ? 20000 : 2000,
        EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS: 1500,
      },
    });
    // FR-VF-001: maximum recording length of 2 minutes.
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
    maxTimerRef.current = setTimeout(() => getNativeSpeechModule()?.stop(), 120000);
    return true;
  }, []);

  const stop = useCallback(() => {
    getNativeSpeechModule()?.stop();
  }, []);

  return {
    start,
    stop,
    listening,
    speechSupported: isNativeSpeechRecognitionAvailable(),
  };
}
