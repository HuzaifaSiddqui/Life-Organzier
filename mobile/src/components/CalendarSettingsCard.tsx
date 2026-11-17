import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Switch, View } from "react-native";
import { useLocale } from "../i18n/LocaleProvider";
import { calendarFeatureOn, calendarSyncActive, disableCalendarSync, enableCalendarSync, type EnableResult } from "../services/calendar";
import { useTheme } from "../theme/ThemeProvider";
import { Icon } from "./icons/Icon";
import { Card, ListItem, SectionTitle, Text } from "./ui";

/**
 * CALENDAR_SYNC: Settings → Phone calendar. Hidden while the server flag is off. One-way: the switch asks for calendar
 * access the first time, then upcoming events are offered as tasks (screens/tasks/CalendarImportScreen.tsx).
 */
export function CalendarSettingsCard(_props: { onToast?: (text: string, action?: { label: string; onPress: () => void }) => void }) {
  const { colors, spacing } = useTheme();
  const { t } = useLocale();
  const [feature, setFeature] = useState(false);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Exclude<EnableResult, "on"> | null>(null);

  const refresh = useCallback(async () => {
    setFeature(await calendarFeatureOn(true));
    setOn(await calendarSyncActive());
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

  if (!feature) return null;
  return (
    <>
      <SectionTitle title={t("calendar.section")} />
      <Card>
        <ListItem
          title={t("calendar.toggle")}
          subtitle={t("calendar.toggleHint")}
          titleLines={0}
          subtitleLines={0}
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
          {problem ? (
            <Text variant="caption" color="danger">
              {t(problem === "denied" ? "calendar.denied" : "calendar.unavailable")}
            </Text>
          ) : null}
        </View>
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  below: { paddingHorizontal: 4 },
});
