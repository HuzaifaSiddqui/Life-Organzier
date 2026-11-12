import { useEffect, useState } from "react";
import { useLocale } from "../i18n/LocaleProvider";
import type { StringKey } from "../i18n/strings";
import { openAppScreen } from "../navigation/navigationRef";
import { subscribeCalendarChanges } from "../services/calendar";
import { pulledNote } from "../utils/calendarSync";
import { Snackbar } from "./ui";

/** CALENDAR_SYNC: an app-level note when a sync brought calendar edits back ("… moved from your calendar · Open"). */
export function CalendarChangesSnackbar() {
  const { t } = useLocale();
  const [note, setNote] = useState<ReturnType<typeof pulledNote>>(null);
  useEffect(() => subscribeCalendarChanges((p) => setNote(pulledNote(p))), []);
  const taskId = note?.taskId;
  return (
    <Snackbar
      text={note ? t(note.key as StringKey, note.vars) : null}
      action={taskId ? { label: t("calendar.pulled.open"), onPress: () => openAppScreen("TaskDetail", { taskId }) } : undefined}
      onHide={() => setNote(null)}
    />
  );
}
