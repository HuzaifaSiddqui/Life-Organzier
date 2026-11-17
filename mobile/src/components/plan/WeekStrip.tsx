import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, SlideInLeft, SlideInRight, useReducedMotion } from "react-native-reanimated";
import { useTheme } from "../../theme/ThemeProvider";
import { dayKey, sameDay } from "../../utils/timeline";
import { PressableScale, Text } from "../primitives";

type Counts = Record<string, { open: number; done: number; overdue: number }>;

/**
 * Seven days with their date; the chosen day is filled, today has a ring, a dot shows a day with something open (red
 * when something is overdue). Swipe sideways for the previous / next week; `direction` slides the new week in.
 */
export function WeekStrip({ days, selected, today, counts, onPick, onShift, direction }: { days: Date[]; selected: Date; today: Date; counts: Counts; onPick: (d: Date) => void; onShift: (weeks: number) => void; direction: number }) {
  const { colors } = useTheme();
  const reduce = useReducedMotion();
  const fling = Gesture.Pan()
    .activeOffsetX([-20, 20])
    .failOffsetY([-14, 14])
    .onEnd((e) => {
      if (Math.abs(e.translationX) > 50 || Math.abs(e.velocityX) > 500) runOnJS(onShift)(e.translationX < 0 ? 1 : -1);
    });
  const entering = reduce ? undefined : (direction >= 0 ? SlideInRight : SlideInLeft).springify().damping(20).stiffness(220);
  return (
    <GestureDetector gesture={fling}>
      <Animated.View key={dayKey(days[0])} entering={entering} style={styles.row}>
        {days.map((d) => {
          const on = sameDay(d, selected);
          const isToday = sameDay(d, today);
          const c = counts[dayKey(d)];
          const dot = c ? (c.overdue ? colors.danger.fg : c.open ? colors.accent : null) : null;
          return (
            <PressableScale
              key={d.toISOString()}
              onPress={() => onPick(d)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}
              style={styles.day}
            >
              <Text variant="label" maxFontSizeMultiplier={1.1} style={{ color: on ? colors.accentStrong : colors.textTertiary, fontSize: 11 }}>
                {d.toLocaleDateString([], { weekday: "narrow" })}
              </Text>
              <View style={[styles.num, on ? { backgroundColor: colors.accent } : isToday ? { borderWidth: 1.5, borderColor: colors.accent } : null]}>
                <Text variant="bodyStrong" maxFontSizeMultiplier={1.1} style={{ color: on ? colors.onAccent : isToday ? colors.accentStrong : colors.text }}>
                  {d.getDate()}
                </Text>
              </View>
              <View style={[styles.dot, { backgroundColor: dot ?? "transparent" }]} />
            </PressableScale>
          );
        })}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row" },
  day: { flex: 1, alignItems: "center", gap: 4, paddingVertical: 4, minHeight: 48 },
  num: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  dot: { width: 5, height: 5, borderRadius: 3 },
});
