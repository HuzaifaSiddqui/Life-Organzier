import Constants, { ExecutionEnvironment } from "expo-constants";

/** Matches expo-speech-recognition native module surface we use. */
export type NativeSpeechModule = {
  start: (options: import("expo-speech-recognition").ExpoSpeechRecognitionOptions) => void;
  stop: () => void;
  abort: () => void;
  requestPermissionsAsync: () => Promise<import("expo-modules-core").PermissionResponse>;
  addListener: (
    event: string,
    listener: (payload: unknown) => void
  ) => { remove: () => void };
};

let cached: NativeSpeechModule | null | undefined;

/**
 * Resolves the speech native module only when not running inside Expo Go.
 * Avoids requiring `expo-speech-recognition` on Expo Go (no native binary → crash).
 */
export function getNativeSpeechModule(): NativeSpeechModule | null {
  if (cached !== undefined) return cached;

  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
    cached = null;
    return null;
  }

  try {
    // Metro resolves this only after we know we're not in Expo Go.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require("expo-speech-recognition") as typeof import("expo-speech-recognition");
    cached = pkg.ExpoSpeechRecognitionModule as NativeSpeechModule;
    return cached;
  } catch {
    cached = null;
    return null;
  }
}

export function isNativeSpeechRecognitionAvailable(): boolean {
  return getNativeSpeechModule() !== null;
}
