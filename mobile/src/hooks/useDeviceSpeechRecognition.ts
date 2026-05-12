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
  /** Fires when recognition stops; includes final merged text. */
  onRecognitionEnd?: (fullText: string) => void;
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
      lastTranscriptRef.current = t;
      if (t.trim().length > 0) receivedResultRef.current = true;
      const prefix = prefixRef.current;
      const full = prefix + (prefix && t ? " " : "") + t;
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
      const prefix = prefixRef.current;
      const t = lastTranscriptRef.current;
      const full = prefix + (prefix && t ? " " : "") + t;
      optsRef.current.onRecognitionEnd?.(full);
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

  const start = useCallback(async (existingText: string) => {
    const mod = getNativeSpeechModule();
    if (!mod) {
      optsRef.current.onError?.(
        "Voice needs a development build — Expo Go does not include speech recognition. Run: npx expo run:ios or npx expo run:android."
      );
      return false;
    }

    prefixRef.current = existingText;
    lastTranscriptRef.current = "";
    receivedResultRef.current = false;

    const perm = await mod.requestPermissionsAsync();
    if (!perm.granted) {
      optsRef.current.onError?.(
        "Microphone or speech recognition permission was denied. Enable it in Settings."
      );
      return false;
    }

    mod.start({
      lang: "en-US",
      interimResults: true,
      continuous: true,
      iosTaskHint: "dictation",
      androidIntentOptions: {
        EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 3000,
        EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 3000,
        EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS: 1500,
      },
    });
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
