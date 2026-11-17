import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedReaction, useAnimatedStyle, useSharedValue, withSpring, withTiming, type SharedValue } from "react-native-reanimated";
import { useLocale } from "../../i18n/LocaleProvider";
import { hapticTap } from "../../services/haptics";
import { useTheme } from "../../theme/ThemeProvider";
import { timeline, withAlpha } from "../../theme/tokens";
import { DAY_MINUTES, SNAP, type Placed } from "../../utils/timeline";
import { Icon } from "../icons/Icon";
import { Text } from "../primitives";
import { clockLabel } from "./clock";

export type DropMode = "move" | "resize";

type Props = {
  item: Placed;
  /** Column of this item's day in the grid, and how many day columns there are (1 = Day view, 7 = Week view). */
  dayIndex: number;
  days: number;
  colW: number;
  color: string;
  onTap: (item: Placed) => void;
  onDrop: (item: Placed, dayDelta: number, start: number, end: number, mode: DropMode) => void;
  onDragging: (on: boolean) => void;
  /** Bumped when a drop was cancelled or failed: the tile springs back to where the store says it is. */
  resetKey?: number;
};

/**
 * One block on the Plan timeline. Tap: open it. Hold (~0.3 s): it lifts and follows the finger, snapping to 15 minutes
 * (and to days in Week view), with a light tick per step and the new time on the tile; release saves (with Undo).
 * Tasks also have a bottom edge to drag for the length. Screen readers: adjustable, ±15 minutes per step.
 */
export function TimelineTile({ item, dayIndex, days, colW, color, onTap, onDrop, onDragging, resetKey = 0 }: Props) {
  const { colors, motion, radii } = useTheme();
  const { t } = useLocale();
  const hourH = timeline.hourHeight;
  const toY = (min: number) => (min / 60) * hourH;
  const top = toY(item.start);
  const height = Math.max(timeline.minTile, toY(item.end - item.start) - 2);
  const w = colW / item.cols;
  const left = dayIndex * colW + item.col * w;
  const length = item.end - item.start;
  // Resizing needs room: Day view only (Week columns are too narrow to aim at an edge).
  const canResize = item.kind === "task" && height >= 36 && days === 1;

  const dy = useSharedValue(0);
  const dx = useSharedValue(0);
  const dh = useSharedValue(0);
  const lift = useSharedValue(0);
  const snapStart = useSharedValue(item.start);
  const snapEnd = useSharedValue(item.end);
  const dayShift = useSharedValue(0);

  // A new position from the store (after a drop or a sync): start from there, no jump back.
  useEffect(() => {
    dy.value = 0;
    dx.value = 0;
    dh.value = 0;
    snapStart.value = item.start;
    snapEnd.value = item.end;
    dayShift.value = 0;
  }, [item.start, item.end, dayIndex, dy, dx, dh, snapStart, snapEnd, dayShift]);

  // A cancelled or failed drop: glide back.
  useEffect(() => {
    if (!resetKey) return;
    dy.value = withSpring(0, motion.spring.snappy);
    dx.value = withSpring(0, motion.spring.snappy);
    dh.value = withSpring(0, motion.spring.snappy);
    snapStart.value = item.start;
    snapEnd.value = item.end;
    dayShift.value = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const tick = () => hapticTap();
  const settle = () => {
    "worklet";
    lift.value = withTiming(0, { duration: motion.duration.fast });
    runOnJS(onDragging)(false);
  };

  const move = Gesture.Pan()
    .activateAfterLongPress(timeline.liftDelay)
    .onStart(() => {
      lift.value = withSpring(1, motion.spring.snappy);
      runOnJS(onDragging)(true);
      runOnJS(tick)();
    })
    .onUpdate((e) => {
      const raw = item.start + (e.translationY / hourH) * 60;
      const s = Math.max(0, Math.min(DAY_MINUTES - Math.max(SNAP, length), Math.round(raw / SNAP) * SNAP));
      const shift = days > 1 ? Math.max(-dayIndex, Math.min(days - 1 - dayIndex, Math.round(e.translationX / colW))) : 0;
      if (s !== snapStart.value || shift !== dayShift.value) runOnJS(tick)();
      snapStart.value = s;
      snapEnd.value = s + length;
      dayShift.value = shift;
      dy.value = ((s - item.start) / 60) * hourH;
      dx.value = shift * colW;
    })
    .onEnd(() => {
      const changed = snapStart.value !== item.start || dayShift.value !== 0;
      if (changed) runOnJS(onDrop)(item, dayShift.value, snapStart.value, snapEnd.value, "move");
      else {
        dy.value = withSpring(0, motion.spring.snappy);
        dx.value = withSpring(0, motion.spring.snappy);
      }
      settle();
    })
    .onFinalize((_e, success) => {
      if (!success) settle();
    });

  const tap = Gesture.Tap().onEnd(() => runOnJS(onTap)(item));
  const body = Gesture.Exclusive(move, tap);

  const resize = Gesture.Pan()
    .activateAfterLongPress(120)
    .onStart(() => {
      lift.value = withSpring(1, motion.spring.snappy);
      runOnJS(onDragging)(true);
      runOnJS(tick)();
    })
    .onUpdate((e) => {
      const raw = item.end + (e.translationY / hourH) * 60;
      const end = Math.max(item.start + SNAP, Math.min(DAY_MINUTES, Math.round(raw / SNAP) * SNAP));
      if (end !== snapEnd.value) runOnJS(tick)();
      snapEnd.value = end;
      dh.value = ((end - item.end) / 60) * hourH;
    })
    .onEnd(() => {
      if (snapEnd.value !== item.end) runOnJS(onDrop)(item, 0, item.start, snapEnd.value, "resize");
      else dh.value = withSpring(0, motion.spring.snappy);
      settle();
    })
    .onFinalize((_e, success) => {
      if (!success) settle();
    });

  const style = useAnimatedStyle(() => ({
    height: Math.max(timeline.minTile, height + dh.value),
    transform: [{ translateY: dy.value }, { translateX: dx.value }, { scale: 1 + lift.value * 0.03 }],
    zIndex: lift.value > 0 ? 50 : 1,
    shadowOpacity: lift.value * 0.22,
    elevation: lift.value * 10,
  }));
  const badge = useAnimatedStyle(() => ({ opacity: lift.value > 0.01 ? 1 : 0 }));

  const muted = item.done || item.muted;
  const bar = item.overdue ? colors.danger.fg : color;
  const timeText = `${clockLabel(item.start)} – ${clockLabel(item.end)}`;
  const narrow = w < 64;
  // Slivers (many overlaps in Week view) show only their colour; the title is in the label for screen readers.
  const tiny = w < 30;
  const label = [item.title, item.deadline ? t("plan.due", { time: clockLabel(item.start) }) : timeText, item.kind === "routine" ? t("plan.routine") : null, item.done ? t("plan.done") : null, item.overdue ? t("plan.overdue") : null]
    .filter(Boolean)
    .join(", ");

  return (
    <Animated.View
      style={[
        styles.tile,
        { top, left: left + 1, width: w - 3, borderRadius: radii.sm + 2, backgroundColor: withAlpha(bar, muted ? 0.08 : 0.16), shadowColor: colors.text, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } },
        style,
      ]}
    >
      <GestureDetector gesture={body}>
        <View
          style={styles.fill}
          accessible
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint={t("plan.dragHint")}
          accessibilityActions={[{ name: "activate" }, { name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === "activate") onTap(item);
            const step = e.nativeEvent.actionName === "increment" ? SNAP : e.nativeEvent.actionName === "decrement" ? -SNAP : 0;
            if (step) onDrop(item, 0, Math.max(0, item.start + step), Math.max(SNAP, item.end + step), "move");
          }}
        >
          <View style={[styles.bar, { backgroundColor: bar, opacity: muted ? 0.5 : 1 }]} />
          {tiny ? null : (
          <View style={[styles.content, narrow && styles.contentNarrow]}>
            <View style={styles.titleRow}>
              {item.kind === "routine" && !narrow ? <Icon name={item.locked ? "lock" : "repeat"} size={12} color={colors.textSecondary} /> : null}
              <Text
                variant="label"
                maxFontSizeMultiplier={1.15}
                numberOfLines={height > 44 ? 2 : 1}
                style={[styles.title, { color: colors.text, textDecorationLine: item.done ? "line-through" : "none", opacity: muted ? 0.6 : 1 }]}
              >
                {item.title}
              </Text>
            </View>
            {height > 38 && !narrow ? (
              <Text variant="caption" maxFontSizeMultiplier={1.1} numberOfLines={1} style={{ color: item.overdue ? colors.danger.fg : colors.textSecondary, fontSize: 11 }}>
                {item.deadline ? t("plan.due", { time: clockLabel(item.start) }) : timeText}
              </Text>
            ) : null}
          </View>
          )}
        </View>
      </GestureDetector>
      <Animated.View pointerEvents="none" style={[styles.badge, { backgroundColor: colors.inverseSurface, borderRadius: radii.sm }, badge]}>
        <LiveTime start={snapStart} end={snapEnd} />
      </Animated.View>
      {canResize ? (
        <GestureDetector gesture={resize}>
          <View style={styles.handleArea} accessibilityElementsHidden importantForAccessibility="no">
            <View style={[styles.handle, { backgroundColor: bar }]} />
          </View>
        </GestureDetector>
      ) : null}
    </Animated.View>
  );
}

/** The time shown on a lifted tile while it moves; React re-renders only on a 15-minute step. */
function LiveTime({ start, end }: { start: SharedValue<number>; end: SharedValue<number> }) {
  const { colors } = useTheme();
  const [range, setRange] = useState<[number, number]>([start.value, end.value]);
  useAnimatedReaction(
    () => start.value * 10000 + end.value,
    (next, prev) => {
      if (next !== prev) runOnJS(setRange)([start.value, end.value]);
    },
  );
  return (
    <Text variant="label" maxFontSizeMultiplier={1} style={{ color: colors.onInverse, fontSize: 11 }}>
      {`${clockLabel(range[0])} – ${clockLabel(range[1])}`}
    </Text>
  );
}

const styles = StyleSheet.create({
  tile: { position: "absolute", overflow: "visible" },
  fill: { flex: 1, flexDirection: "row", overflow: "hidden", borderRadius: 10 },
  bar: { width: 3 },
  content: { flex: 1, paddingHorizontal: 6, paddingVertical: 3, gap: 1 },
  contentNarrow: { paddingHorizontal: 3 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  title: { flex: 1, fontSize: 12, lineHeight: 15 },
  badge: { position: "absolute", top: -26, left: 0, paddingHorizontal: 8, paddingVertical: 4 },
  handleArea: { position: "absolute", left: 0, right: 0, bottom: -8, height: 20, alignItems: "center", justifyContent: "center" },
  handle: { width: 22, height: 4, borderRadius: 2, opacity: 0.7 },
});
