import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useMemo, useState } from "react";
import { Platform, SectionList, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition, useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { friendlyDate } from "../../components/DueDateTimePickers";
import { Icon } from "../../components/icons/Icon";
import { clockLabel } from "../../components/plan/clock";
import { Button, EmptyState, IconButton, Snackbar, Text } from "../../components/primitives";
import { useLocale } from "../../i18n/LocaleProvider";
import type { MainStackParamList } from "../../navigation/MainStack";
import { addImports, pendingImports, skipImports, subscribeCalendarImports, syncCalendar } from "../../services/calendar";
import { hapticDone, hapticTap } from "../../services/haptics";
import { useTheme } from "../../theme/ThemeProvider";
import { eventYmd, type ImportCandidate } from "../../utils/calendarSync";

type Props = NativeStackScreenProps<MainStackParamList, "CalendarImport">;

const minutesOf = (iso: string) => {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
};

/**
 * From your calendar (CALENDAR_SYNC, one-way): upcoming events in the phone's calendars, grouped by day. Add makes
 * a task (planned for the event's time), Skip hides it for good; Add all / Skip all at the bottom. Nothing is written
 * to the calendar.
 */
export function CalendarImportScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { colors, spacing, radii } = useTheme();
  const { t } = useLocale();
  const reduce = useReducedMotion();
  const [items, setItems] = useState<ImportCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [snack, setSnack] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void pendingImports().then((p) => live && setItems(p));
    void syncCalendar();
    const off = subscribeCalendarImports((p) => setItems(p.filter((c) => Date.parse(c.end) > Date.now())));
    return () => {
      live = false;
      off();
    };
  }, []);

  const sections = useMemo(() => {
    const byDay = new Map<string, ImportCandidate[]>();
    for (const c of items ?? []) {
      const ymd = eventYmd(c, Platform.OS === "android");
      byDay.set(ymd, [...(byDay.get(ymd) ?? []), c]);
    }
    return [...byDay.entries()].map(([ymd, data]) => ({ title: friendlyDate(ymd, t), data }));
  }, [items, t]);

  const add = async (keys: string[]) => {
    hapticDone();
    setBusy(true);
    const n = await addImports(keys, t("calendar.import.note"));
    setBusy(false);
    if (n) setSnack(n === 1 ? t("calendar.import.addedOne") : t("calendar.import.addedMany", { count: String(n) }));
  };
  const skip = async (keys: string[]) => {
    hapticTap();
    await skipImports(keys);
    setSnack(t("calendar.import.skipped"));
  };
  const all = (items ?? []).map((c) => c.key);

  return (
    <View style={[styles.root, { backgroundColor: colors.canvas, paddingTop: insets.top + 4 }]}>
      <View style={[styles.top, { paddingHorizontal: spacing.sm }]}>
        <IconButton icon={<Icon name="back" size={22} color={colors.text} />} onPress={() => navigation.goBack()} accessibilityLabel={t("common.back")} />
        <View style={styles.flex}>
          <Text variant="headline" accessibilityRole="header">
            {t("calendar.import.title")}
          </Text>
          <Text variant="caption" color="secondary">
            {t("calendar.import.hint")}
          </Text>
        </View>
      </View>

      {items && !items.length ? (
        <View style={styles.emptyWrap}>
          <EmptyState icon={<Icon name="calendar" size={40} color={colors.accent} />} title={t("calendar.import.empty")} text={t("calendar.import.emptyHint")} />
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(c) => c.key}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: 120 + insets.bottom, gap: spacing.sm }}
          renderSectionHeader={({ section }) => (
            <Text variant="label" color="secondary" style={{ marginTop: spacing.md, marginBottom: spacing.xs }}>
              {section.title.toUpperCase()}
            </Text>
          )}
          renderItem={({ item: c }) => (
            <Animated.View
              entering={reduce ? undefined : FadeIn.duration(180)}
              exiting={reduce ? undefined : FadeOut.duration(160)}
              layout={reduce ? undefined : LinearTransition.duration(200)}
              style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.hairline, borderRadius: radii.lg, gap: spacing.md }]}
            >
              <View style={[styles.when, { borderColor: colors.accent }]}>
                <Text variant="label" color="accent" tabular numberOfLines={1}>
                  {c.allDay ? t("calendar.allDay") : clockLabel(minutesOf(c.start))}
                </Text>
                {!c.allDay ? (
                  <Text variant="caption" color="tertiary" tabular numberOfLines={1}>
                    {clockLabel(minutesOf(c.end))}
                  </Text>
                ) : null}
              </View>
              <View style={styles.flex}>
                <Text variant="bodyStrong" numberOfLines={2}>
                  {c.title}
                </Text>
                {c.location ? (
                  <View style={styles.place}>
                    <Icon name="pin" size={12} color={colors.textTertiary} />
                    <Text variant="caption" color="secondary" numberOfLines={1} style={styles.flex}>
                      {c.location}
                    </Text>
                  </View>
                ) : null}
              </View>
              <IconButton
                icon={<Icon name="close" size={18} color={colors.textSecondary} />}
                onPress={() => void skip([c.key])}
                accessibilityLabel={`${t("calendar.import.skip")}: ${c.title}`}
              />
              <Button title={t("calendar.import.add")} size="sm" kind="tonal" icon={<Icon name="plus" size={16} color={colors.accentStrong} />} disabled={busy} onPress={() => void add([c.key])} accessibilityLabel={`${t("calendar.import.add")}: ${c.title}`} />
            </Animated.View>
          )}
        />
      )}

      {items && items.length > 1 ? (
        <View style={[styles.footer, { backgroundColor: colors.surface, borderColor: colors.hairline, paddingBottom: Math.max(insets.bottom, spacing.md), padding: spacing.md, gap: spacing.sm }]}>
          <Button title={t("calendar.import.skipAll")} kind="ghost" disabled={busy} onPress={() => void skip(all)} style={styles.flex} />
          <Button title={t("calendar.import.addAll", { count: String(all.length) })} loading={busy} disabled={busy} onPress={() => void add(all)} style={styles.grow} />
        </View>
      ) : null}
      <Snackbar text={snack} onHide={() => setSnack(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  top: { flexDirection: "row", alignItems: "center", gap: 4, paddingBottom: 8 },
  flex: { flex: 1 },
  grow: { flex: 2 },
  emptyWrap: { flex: 1, justifyContent: "center", padding: 24 },
  row: { flexDirection: "row", alignItems: "center", padding: 14, borderWidth: StyleSheet.hairlineWidth },
  when: { minWidth: 64, borderLeftWidth: 3, paddingLeft: 8, gap: 2 },
  place: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  footer: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth },
});
