import AsyncStorage from "@react-native-async-storage/async-storage";
import { auth } from "../lib/firebase";

/**
 * The last copy of each screen's server data, kept on the device per signed-in user. Screens show it at once
 * (also offline) and refresh in the background (hooks/useCachedQuery.ts). Tasks have their own store (syncEngine).
 */

const PREFIX = "life-organizer:cache:";

function keyFor(name: string, uid = auth.currentUser?.uid): string | null {
  return uid ? `${PREFIX}${uid}:${name}` : null;
}

export async function readCache<T>(name: string): Promise<T | null> {
  const key = keyFor(name);
  if (!key) return null;
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function writeCache(name: string, value: unknown): Promise<void> {
  const key = keyFor(name);
  if (!key) return;
  await AsyncStorage.setItem(key, JSON.stringify(value)).catch(() => undefined);
}

/** Sign-out: nothing of this user's data stays on the device. */
export async function clearUserCache(uid: string): Promise<void> {
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(`${PREFIX}${uid}:`));
    if (keys.length) await AsyncStorage.multiRemove(keys);
  } catch {
    // ignore
  }
}
