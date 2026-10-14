import { useEffect, useState } from "react";
import { subscribeLocationSnackbar, type LocationSnack } from "../services/locationReminders";
import { Snackbar } from "./ui";

/** App-level location messages (FR-LB-001): the one-time permission hint and "Location removed · Undo". */
export function LocationSnackbar() {
  const [snack, setSnack] = useState<LocationSnack | null>(null);
  useEffect(() => subscribeLocationSnackbar(setSnack), []);
  return <Snackbar text={snack?.text ?? null} action={snack?.action} onHide={() => setSnack(null)} />;
}
