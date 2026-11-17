import { createNavigationContainerRef } from "@react-navigation/native";

export const navigationRef = createNavigationContainerRef();

/** Kept in step with TAB_ROUTES in MainStack.tsx (not imported: that file imports every screen). */
const TAB_NAMES = new Set(["Dashboard", "Plan", "TaskList", "Profile"]);

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
  // The tab screens (Today, Plan, Insights, Me) live inside "Tabs".
  const inner = TAB_NAMES.has(screen) ? { screen: "Tabs", params: { screen, params } } : { screen, params };
  (navigationRef.navigate as (name: string, params?: object) => void)("App", inner);
}

/** Called from NavigationContainer onReady. */
export function flushPendingNavigation(): void {
  if (!pending || !navigationRef.isReady()) return;
  const p = pending;
  pending = null;
  openAppScreen(p.screen, p.params);
}
