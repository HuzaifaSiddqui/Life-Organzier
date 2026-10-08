import { createNavigationContainerRef } from "@react-navigation/native";

export const navigationRef = createNavigationContainerRef();

let pending: { screen: string; params?: Record<string, unknown> } | null = null;

/**
 * Opens a screen inside the signed-in app stack from outside React (e.g. a notification tap). A tap
 * that launched the app arrives before navigation is ready; it is kept and opened on `flushPendingNavigation`.
 */
export function openAppScreen(screen: string, params?: Record<string, unknown>): void {
  if (!navigationRef.isReady()) {
    pending = { screen, params };
    return;
  }
  (navigationRef.navigate as (name: string, params?: object) => void)("App", { screen, params });
}

/** Called from NavigationContainer onReady. */
export function flushPendingNavigation(): void {
  if (!pending || !navigationRef.isReady()) return;
  const p = pending;
  pending = null;
  openAppScreen(p.screen, p.params);
}
