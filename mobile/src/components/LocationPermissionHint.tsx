import { useEffect, useState } from "react";
import { subscribeLocationHint } from "../services/locationReminders";
import { Snackbar } from "./ui";

/** One-time hint after "While using the app" was chosen for location reminders (FR-LB-001). */
export function LocationPermissionHint() {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => subscribeLocationHint(setText), []);
  return <Snackbar text={text} onHide={() => setText(null)} />;
}
