import { useCallback, useEffect, useState } from "react";
import { Alert, StyleSheet, Switch, View } from "react-native";
import { useLocale } from "../i18n/LocaleProvider";
import {
  calendarFeatureOn,
  calendarSyncActive,
  disableCalendarSync,
  enableCalendarSync,
  ourEventCount,
  removeAllCalendarEvents,
  type EnableResult,
} from "../services/calendar";
import { useTheme } from "../theme/ThemeProvider";
import { Icon } from "./icons/Icon";
import { Button, Card, ListItem, SectionTitle, Text } from "./ui";

/**
 * CALENDAR_SYNC: Settings → Phone calendar. Hidden while the server flag is off. The switch asks for calendar access
 * the first time; "Remove all" shows how many events go, asks, then offers Undo (turning sync back on re-creates them).
 */
export function CalendarSettingsCard({ onToast }: { onToast: (text: string, action?: { label: string; onPress: () => void }) => void }) {
  const { colors, spacing } = useTheme();
  const { t } = useLocale();
  const [feature, setFeature] = useState(false);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Exclude<EnableResult, "on"> | null>(null);
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    setFeature(await calendarFeatureOn(true));
    setOn(await calendarSyncActive());
    setCount(await ourEventCount());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const turnOn = async () => {
    setBusy(true);
    const r = await enableCalendarSync();
    setBusy(false);
    setProblem(r === "on" ? null : r);
    await refresh();
    return r;
  };

  const toggle = async (value: boolean) => {
    if (value) return void (await turnOn());
    await disableCalendarSync();
    setProblem(null);
    await refresh();
  };

  const removeAll = async () => {
    const n = await ourEventCount();
    Alert.alert(t("calendar.removeTitle"), t("calendar.removeBody", { count: String(n) }), [
      { text: t("calendar.cancel"), style: "cancel" },
      {
        text: t("calendar.remove"),
        style: "destructive",
        onPress: () =>
          void (async () => {
            setBusy(true);
            const ok = await removeAllCalendarEvents();
            setBusy(false);
            await refresh();
            if (!ok) return onToast(t("calendar.removeFailed"));
            onToast(t("calendar.removed"), { label: t("calendar.undo"), onPress: () => void turnOn() });
          })(),
      },
    ]);
  };

  if (!feature) return null;
  return (
    <>
      <SectionTitle title={t("calendar.section")} />
      <Card>
        <ListItem
          title={t("calendar.toggle")}
          subtitle={t("calendar.toggleHint")}
          leading={<Icon name="calendar" size={20} color={colors.accent} />}
          trailing={
            <Switch
              value={on}
              disabled={busy}
              onValueChange={(v) => void toggle(v)}
              trackColor={{ true: colors.accent, false: colors.hairline }}
              accessibilityLabel={t("calendar.toggle")}
            />
          }
        />
        <View style={[styles.below, { gap: spacing.sm }]}>
          <Text variant="caption" color="secondary">
            {t("calendar.offNote")}
          </Text>
          <Text variant="caption" color="secondary">
            {t("calendar.twoWayHint")}
          </Text>
          {problem ? (
            <Text variant="caption" color="danger">
              {t(problem === "denied" ? "calendar.denied" : "calendar.unavailable")}
            </Text>
          ) : null}
          {count > 0 ? <Button title={t("calendar.removeAll")} kind="ghost" size="sm" disabled={busy} onPress={() => void removeAll()} style={styles.start} /> : null}
        </View>
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  below: { paddingHorizontal: 4 },
  start: { alignSelf: "flex-start" },
});
