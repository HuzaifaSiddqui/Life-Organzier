import { Platform } from "react-native";

/**
 * Features the web / desktop build doesn't have (docs/known-limitations.md "Desktop"). Their screens hide the
 * controls instead of offering something that can't work there.
 * - Location reminders need the phone's background geofencing (and the map picker is a native WebView).
 * - Voice input uses the phone's speech recogniser; desktop Chromium has none without Google keys.
 * - Sound / vibration style is how the phone alerts; Windows decides how its notifications look and sound.
 */
export const platformFeatures = {
  locationReminders: Platform.OS !== "web",
  voiceInput: Platform.OS !== "web",
  phoneAlertStyle: Platform.OS !== "web",
} as const;
