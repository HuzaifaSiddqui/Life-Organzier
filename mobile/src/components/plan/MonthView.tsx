import { ScrollView, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { FadeIn, runOnJS, useReducedMotion } from "react-native-reanimated";
import { useLocale } from "../../i18n/LocaleProvider";
import { useTheme } from "../../theme/ThemeProvider";
import { withAlpha } from "../../theme/tokens";
import { dayKey, sameDay, type DayPlan, type TimelineItem } from "../../utils/timeline";
import { PressableScale, Text } from "../primitives";

/**
 * Month view: six weeks; each day shows up to three items as small coloured bars (title when there's room) and
 * "+N more"; overdue days get a red date. Tap a day to open it in Day view; swipe sideways for another month.
 */
export function MonthView({ month, grid, plans, today, selected, colorOf, onPick, onShift, bottomInset }: { month: Date; grid: Date[][]; plans: Record<string, DayPlan>; today: Date; selected: Date; colorOf: (i: TimelineItem) => string; onPick: (d: Date) => void; onShift: (months: number) => void; bottomInset: number }) {
  const { colors, radii } = useTheme();
  const { t } = useLocale();
  const reduce = useReducedMotion();
  const fling = Gesture.Pan()
    .activeOffsetX([-24, 24])
    .failOffsetY([-14, 14])
    .onEnd((e) => {
      if (Math.abs(e.translationX) > 60 || Math.abs(e.velocityX) > 500) runOnJS(onShift)(e.translationX < 0 ? 1 : -1);
    });
  const weekdays = grid[0].map((d) => d.toLocaleDateString([], { weekday: "narrow" }));
  return (
    <GestureDetector gesture={fling}>
      <ScrollView contentContainerStyle={{ paddingBottom: bottomInset }} showsVerticalScrollIndicator={false}>
        <View style={styles.week}>
          {weekdays.map((w, i) => (
            <Text key={i} variant="label" color="tertiary" center style={styles.flex}>
              {w}
            </Text>
          ))}
        </View>
        <Animated.View key={`${month.getFullYear()}-${month.getMonth()}`} entering={reduce ? undefined : FadeIn.duration(200)}>
          {grid.map((week) => (
            <View key={dayKey(week[0])} style={[styles.week, { borderTopColor: colors.hairline }, styles.weekRow]}>
              {week.map((d) => {
                const p = plans[dayKey(d)];
                const items = p ? [...p.allDay, ...p.timed].filter((i) => !i.muted) : [];
                const inMonth = d.getMonth() === month.getMonth();
                const isToday = sameDay(d, today);
                const on = sameDay(d, selected);
                const overdue = items.some((i) => i.overdue);
                return (
                  <PressableScale
                    key={d.toISOString()}
                    onPress={() => onPick(d)}
                    scale={false}
                    accessibilityRole="button"
                    accessibilityLabel={`${d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}, ${items.length}`}
                    style={[styles.cell, on && { backgroundColor: colors.accentSoft, borderRadius: radii.sm }]}
                  >
                    <View style={[styles.num, isToday && { backgroundColor: colors.accent }]}>
                      <Text
                        variant="label"
                        maxFontSizeMultiplier={1.1}
                        style={{ fontSize: 12, color: isToday ? colors.onAccent : overdue ? colors.danger.fg : inMonth ? colors.text : colors.textTertiary, opacity: inMonth ? 1 : 0.5 }}
                      >
                        {d.getDate()}
                      </Text>
                    </View>
                    {items.slice(0, 3).map((i) => (
                      <View key={i.key} style={[styles.bar, { backgroundColor: withAlpha(colorOf(i), i.done ? 0.12 : 0.22), borderStartColor: colorOf(i) }]}>
                        <Text numberOfLines={1} maxFontSizeMultiplier={1} style={{ fontSize: 9, lineHeight: 12, color: colors.text, opacity: i.done ? 0.5 : 1 }}>
                          {i.title}
                        </Text>
                      </View>
                    ))}
                    {items.length > 3 ? (
                      <Text maxFontSizeMultiplier={1} style={{ fontSize: 9, color: colors.textTertiary }}>
                        {t("plan.more", { count: items.length - 3 })}
                      </Text>
                    ) : null}
                  </PressableScale>
                );
              })}
            </View>
          ))}
        </Animated.View>
      </ScrollView>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  week: { flexDirection: "row", paddingVertical: 6 },
  weekRow: { borderTopWidth: StyleSheet.hairlineWidth, minHeight: 96, paddingVertical: 2 },
  cell: { flex: 1, paddingHorizontal: 2, paddingVertical: 2, gap: 2, alignItems: "stretch" },
  num: { alignSelf: "center", width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center", marginBottom: 2 },
  bar: { borderStartWidth: 2, borderRadius: 3, paddingHorizontal: 2, paddingVertical: 1 },
});
