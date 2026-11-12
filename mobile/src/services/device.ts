import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { isDesktopApp } from "./desktopBridge";

const KEY = "life-organizer:device-id";
let cached: string | null = null;

/** Stable per-install id, recorded with every change for multi-device sync (FR-MS-004). */
export async function getDeviceId(): Promise<string> {
  if (cached) return cached;
  try {
    const stored = await AsyncStorage.getItem(KEY);
    if (stored) {
      cached = stored;
      return stored;
    }
  } catch {
    // fall through and generate
  }
  // Desktop (Electron) and plain browsers both run the web build; the id says which, for sync history (FR-MS-004).
  const kind = Platform.OS === "web" ? (isDesktopApp() ? "desktop" : "web") : Platform.OS;
  const id = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  cached = id;
  try {
    await AsyncStorage.setItem(KEY, id);
  } catch {
    // ignore — id stays in memory for this session
  }
  return id;
}
