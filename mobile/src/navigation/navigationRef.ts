import { createNavigationContainerRef } from "@react-navigation/native";

export const navigationRef = createNavigationContainerRef();

/** Opens a screen inside the signed-in app stack from outside React (e.g. a notification tap). */
export function openAppScreen(screen: string, params?: Record<string, unknown>): void {
  if (!navigationRef.isReady()) return;
  (navigationRef.navigate as (name: string, params?: object) => void)("App", { screen, params });
}
