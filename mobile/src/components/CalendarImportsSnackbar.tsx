import { useEffect, useRef, useState } from "react";
import { useLocale } from "../i18n/LocaleProvider";
import { openAppScreen } from "../navigation/navigationRef";
import { pendingImports, subscribeCalendarImports } from "../services/calendar";
import { Snackbar } from "./ui";

/**
 * CALENDAR_SYNC (one-way): an app-level note when a sync finds new events in the phone's calendar
 * ("2 new in your calendar · Review"). Only new arrivals: what was already waiting at app start is on Today's card.
 */
export function CalendarImportsSnackbar() {
  const { t } = useLocale();
  const [text, setText] = useState<string | null>(null);
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    void pendingImports().then((p) => {
      known.current ??= new Set(p.map((c) => c.key));
    });
    return subscribeCalendarImports((pending) => {
      const before = known.current ?? new Set<string>();
      const fresh = pending.filter((c) => !before.has(c.key)).length;
      known.current = new Set([...before, ...pending.map((c) => c.key)]);
      if (fresh) setText(fresh === 1 ? t("calendar.import.snackOne") : t("calendar.import.snack", { count: String(fresh) }));
    });
  }, [t]);
  return <Snackbar text={text} action={{ label: t("calendar.import.review"), onPress: () => openAppScreen("CalendarImport") }} onHide={() => setText(null)} />;
}
