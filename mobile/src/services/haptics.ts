/**
 * UI v2: light haptic feedback (expo-haptics, already in the build). It follows the phone's own haptics / vibration
 * setting, never blocks, and does nothing where the module or hardware is missing.
 *  - done: a task or routine marked done
 *  - tap: a selection (range chip) or a start
 *  - warn: before a destructive confirm (delete)
 */
type HapticsModule = typeof import("expo-haptics");
let mod: HapticsModule | null | undefined;

async function load(): Promise<HapticsModule | null> {
  if (mod === undefined) mod = await import("expo-haptics").catch(() => null);
  return mod;
}

export function hapticDone(): void {
  void load().then((h) => h?.notificationAsync(h.NotificationFeedbackType.Success).catch(() => undefined));
}

export function hapticTap(): void {
  void load().then((h) => h?.selectionAsync().catch(() => undefined));
}

export function hapticWarn(): void {
  void load().then((h) => h?.notificationAsync(h.NotificationFeedbackType.Warning).catch(() => undefined));
}
