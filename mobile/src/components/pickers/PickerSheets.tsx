import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { FadeIn, runOnJS, useReducedMotion, ZoomIn } from "react-native-reanimated";
import { useLocale } from "../../i18n/LocaleProvider";
import type { StringKey } from "../../i18n/strings";
import { hapticTap } from "../../services/haptics";
import { useTheme } from "../../theme/ThemeProvider";
import { clock12Text, from12, minuteOptions, parseYmd, quickDates, quickTimes, to12, type Clock12 } from "../../utils/pickers";
import { dayKey, monthGrid, sameDay, startOfDay } from "../../utils/timeline";
import { parseDueTimeToHoursMinutes } from "../../utils/datetimeValidation";
import { Icon } from "../icons/Icon";
import { Button, Chip, IconButton, PressableScale, Sheet, Text } from "../primitives";
import { Wheel, WHEEL_ITEM } from "./Wheel";

/**
 * UI v3 date picker: quick choices (Today, Tomorrow, This weekend, Next week, No date) and a month calendar (swipe or
 * arrows for other months; the chosen day pops; today ringed; past days faded but allowed). A day tap picks it and
 * closes; `ymd` is "YYYY-MM-DD" ("" = none).
 */
export function DatePickerSheet({ visible, onClose, ymd, onPick, onClear, title }: { visible: boolean; onClose: () => void; ymd: string; onPick: (ymd: string) => void; onClear?: () => void; title?: string }) {
  const { colors, radii, spacing } = useTheme();
  const { t } = useLocale();
  const reduce = useReducedMotion();
  const today = startOfDay(new Date());
  const chosen = parseYmd(ymd);
  const [month, setMonth] = useState(() => chosen ?? today);
  useEffect(() => {
    if (visible) setMonth(parseYmd(ymd) ?? startOfDay(new Date()));
  }, [visible, ymd]);
  const grid = useMemo(() => monthGrid(month), [month]);
  const shift = (n: number) => {
    hapticTap();
    setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  };
  const fling = Gesture.Pan()
    .activeOffsetX([-24, 24])
    .failOffsetY([-14, 14])
    .onEnd((e) => {
      if (Math.abs(e.translationX) > 50 || Math.abs(e.velocityX) > 500) runOnJS(shift)(e.translationX < 0 ? 1 : -1);
    });
  const pick = (d: Date) => {
    hapticTap();
    onPick(dayKey(d));
    onClose();
  };
  const quick: Record<string, StringKey> = { today: "picker.today", tomorrow: "picker.tomorrow", weekend: "picker.weekend", nextWeek: "picker.nextWeek" };
  return (
    <Sheet visible={visible} onClose={onClose} title={title ?? t("picker.date")}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm, paddingBottom: spacing.md }}>
        {quickDates().map((q) => (
          <Chip key={q.key} label={t(quick[q.key])} selected={q.ymd === ymd} onPress={() => pick(parseYmd(q.ymd) as Date)} />
        ))}
        {onClear ? (
          <Chip
            label={t("picker.noDate")}
            selected={!ymd}
            onPress={() => {
              onClear();
              onClose();
            }}
          />
        ) : null}
      </ScrollView>
      <View style={styles.monthRow}>
        <IconButton icon={<Icon name="back" size={20} color={colors.text} />} onPress={() => shift(-1)} accessibilityLabel={t("picker.prevMonth")} />
        <Text variant="headline" center style={{ flex: 1 }}>
          {month.toLocaleDateString([], { month: "long", year: "numeric" })}
        </Text>
        <IconButton icon={<Icon name="chevron" size={20} color={colors.text} />} onPress={() => shift(1)} accessibilityLabel={t("picker.nextMonth")} />
      </View>
      <GestureDetector gesture={fling}>
        <Animated.View key={`${month.getFullYear()}-${month.getMonth()}`} entering={reduce ? undefined : FadeIn.duration(160)}>
          <View style={styles.week}>
            {grid[0].map((d) => (
              <Text key={d.getDay()} variant="label" color="tertiary" center style={styles.cell}>
                {d.toLocaleDateString([], { weekday: "narrow" })}
              </Text>
            ))}
          </View>
          {grid.map((week) => (
            <View key={dayKey(week[0])} style={styles.week}>
              {week.map((d) => {
                const inMonth = d.getMonth() === month.getMonth();
                const on = chosen ? sameDay(d, chosen) : false;
                const isToday = sameDay(d, today);
                const past = d < today;
                return (
                  <PressableScale
                    key={dayKey(d)}
                    onPress={() => pick(d)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={`${d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}${past ? `, ${t("picker.past")}` : ""}`}
                    style={styles.cell}
                  >
                    {on ? (
                      <Animated.View entering={reduce ? undefined : ZoomIn.springify().damping(14)} style={[styles.day, { backgroundColor: colors.accent, borderRadius: radii.pill }]}>
                        <Text variant="bodyStrong" style={{ color: colors.onAccent }}>
                          {d.getDate()}
                        </Text>
                      </Animated.View>
                    ) : (
                      <View style={[styles.day, isToday && { borderWidth: 1.5, borderColor: colors.accent, borderRadius: radii.pill }]}>
                        <Text variant="body" style={{ color: isToday ? colors.accentStrong : inMonth ? colors.text : colors.textTertiary, opacity: past ? 0.45 : inMonth ? 1 : 0.5 }}>
                          {d.getDate()}
                        </Text>
                      </View>
                    )}
                  </PressableScale>
                );
              })}
            </View>
          ))}
        </Animated.View>
      </GestureDetector>
    </Sheet>
  );
}

/**
 * UI v3 time picker: quick times, then three wheels (hour, minute in 5s, AM / PM) with the chosen time in large type
 * above. "Set" saves; `time` is the app's "9:05 AM" text ("" = none).
 */
export function TimePickerSheet({ visible, onClose, time, onPick, onClear, title }: { visible: boolean; onClose: () => void; time: string; onPick: (time: string) => void; onClear?: () => void; title?: string }) {
  const { colors, radii, spacing } = useTheme();
  const { t } = useLocale();
  const initial = (): Clock12 => {
    const hm = parseDueTimeToHoursMinutes(time) ?? { h: 9, m: 0 };
    return to12(hm.h, hm.m);
  };
  const [value, setValue] = useState<Clock12>(initial);
  useEffect(() => {
    if (visible) setValue(initial());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  const hours = Array.from({ length: 12 }, (_, i) => i + 1);
  const minutes = useMemo(() => minuteOptions(5, value.minute), [value.minute]);
  const quickKey: Record<string, StringKey> = { inHour: "picker.inHour", morning: "picker.morning", noon: "picker.noon", afternoon: "picker.afternoon", evening: "picker.evening", night: "picker.night" };
  const set = (c: Clock12) => setValue(c);
  return (
    <Sheet visible={visible} onClose={onClose} title={title ?? t("picker.time")}>
      <Text variant="display" center tabular accessibilityLiveRegion="polite" style={{ marginBottom: spacing.md }}>
        {clock12Text(value)}
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm, paddingBottom: spacing.md }}>
        {quickTimes().map((q) => {
          const c = to12(q.h, q.m);
          return <Chip key={q.key} small label={q.key === "inHour" ? t(quickKey[q.key]) : `${t(quickKey[q.key])} ${clock12Text(c).replace(":00", "")}`} selected={c.hour === value.hour && c.minute === value.minute && c.pm === value.pm} onPress={() => set(c)} />;
        })}
      </ScrollView>
      <View style={styles.wheels}>
        <View pointerEvents="none" style={[styles.band, { backgroundColor: colors.accentSoft, borderRadius: radii.md, top: WHEEL_ITEM * 2 }]} />
        <Wheel label={t("picker.hour")} items={hours.map(String)} index={value.hour - 1} onChange={(i) => set({ ...value, hour: hours[i] })} />
        <Text variant="title2" style={{ color: colors.textTertiary }}>
          :
        </Text>
        <Wheel label={t("picker.minute")} items={minutes.map((m) => String(m).padStart(2, "0"))} index={Math.max(0, minutes.indexOf(value.minute))} onChange={(i) => set({ ...value, minute: minutes[i] })} />
        <Wheel label={t("picker.ampm")} items={["AM", "PM"]} index={value.pm ? 1 : 0} onChange={(i) => set({ ...value, pm: i === 1 })} />
      </View>
      <View style={[styles.actions, { gap: spacing.sm, marginTop: spacing.lg }]}>
        {onClear ? (
          <Button
            title={t("picker.noTime")}
            kind="ghost"
            onPress={() => {
              onClear();
              onClose();
            }}
          />
        ) : null}
        <Button
          title={t("picker.set")}
          style={{ flex: 1 }}
          onPress={() => {
            const { h, m } = from12(value);
            onPick(clock12Text(to12(h, m)));
            onClose();
          }}
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  monthRow: { flexDirection: "row", alignItems: "center", marginBottom: 4 },
  week: { flexDirection: "row" },
  cell: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 44 },
  day: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  wheels: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4 },
  band: { position: "absolute", left: 0, right: 0, height: WHEEL_ITEM },
  actions: { flexDirection: "row", alignItems: "center" },
});
