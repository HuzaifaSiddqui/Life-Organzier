import { Alert, Platform } from "react-native";
import type { AlertButton } from "../utils/alertButtons";

/**
 * `showAlert` has Alert.alert's signature. On the phone it *is* Alert.alert; on web / desktop (where Alert.alert does
 * nothing) it shows the themed in-app dialog rendered by components/DialogHost. Use it instead of Alert.alert.
 */

export type AlertOptions = { cancelable?: boolean; onDismiss?: () => void };
export type AlertState = { title: string; message?: string; buttons?: AlertButton[]; options?: AlertOptions };

const listeners = new Set<(s: AlertState | null) => void>();

export function showAlert(title: string, message?: string, buttons?: AlertButton[], options?: AlertOptions): void {
  if (Platform.OS !== "web") {
    Alert.alert(title, message, buttons, options);
    return;
  }
  listeners.forEach((l) => l({ title, message, buttons, options }));
}

export function subscribeAlerts(listener: (s: AlertState | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
