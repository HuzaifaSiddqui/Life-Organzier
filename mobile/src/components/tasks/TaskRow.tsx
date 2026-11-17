import { useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import ReanimatedSwipeable, { SwipeDirection, type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, { interpolate, Extrapolation, useAnimatedStyle, useReducedMotion, useSharedValue, withSequence, withSpring, withTiming, type SharedValue } from "react-native-reanimated";
import { useLocale } from "../../i18n/LocaleProvider";
import type { StringKey } from "../../i18n/strings";
import { useTheme } from "../../theme/ThemeProvider";
import { touchTarget } from "../../theme/tokens";
import type { Task } from "../../types/models";
import { formatDue, formatDuration, isOverdue } from "../../utils/format";
import { Icon } from "../icons/Icon";
import { Dot, Text } from "../primitives";
import { HighlightText } from "../ui";

type Props = {
  task: Task;
  query?: string;
  categoryColor?: string;
  stepCount?: number;
  expanded?: boolean;
  onToggleExpand?: () => void;
  onOpen: () => void;
  onToggleDone: () => void;
  onTomorrow: () => void;
  onMenu: () => void;
  onStart?: () => void;
  compact?: boolean;
};

/**
 * UI v3 task row (docs/design.md "Tasks"): a round tick (one tap = done), the title, one meta line (when, length,
 * category, steps) and the priority flag for urgent / high. Swipe right = Done, swipe left = Tomorrow (the action
 * reveals and grows under the row, then runs on release past the threshold); hold = the action sheet.
 */
export function TaskRow({ task, query = "", categoryColor, stepCount, expanded, onToggleExpand, onOpen, onToggleDone, onTomorrow, onMenu, onStart, compact }: Props) {
  const { colors, motion } = useTheme();
  const { t } = useLocale();
  const reduce = useReducedMotion();
  const ref = useRef<SwipeableMethods>(null);
  const pop = useSharedValue(1);
  const tickStyle = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));
  const done = task.status === "COMPLETED";
  const overdue = isOverdue(task);
  const started = task.status === "IN_PROGRESS";
  const progress = task.progress ?? 0;
  const when = task.dueAt || task.dueDate || task.scheduledStart ? formatDue(task) : null;
  const meta = [when, task.durationMinutes ? formatDuration(task.durationMinutes) : null, task.category, stepCount ? t("tasks.steps", { count: stepCount }) : null].filter(Boolean).join(" · ");
  const flag = task.priority === "URGENT" || task.priority === "HIGH";

  const tick = () => {
    if (!reduce) pop.value = withSequence(withTiming(0.7, { duration: motion.duration.fast }), withSpring(1, motion.spring.snappy));
    onToggleDone();
  };

  const row = (
    <Pressable
      onPress={onOpen}
      onLongPress={onMenu}
      delayLongPress={350}
      accessibilityRole="button"
      accessibilityLabel={[task.title, t(`prio.${task.priority}` as StringKey), overdue ? t("plan.overdue") : null, when].filter(Boolean).join(", ")}
      accessibilityActions={[{ name: "activate" }, { name: "longpress" }, { name: "done", label: t(done ? "detail.reopen" : "detail.markDone") }, { name: "tomorrow", label: t("action.moveTomorrow") }]}
      onAccessibilityAction={(e) => {
        const a = e.nativeEvent.actionName;
        if (a === "activate") onOpen();
        else if (a === "longpress") onMenu();
        else if (a === "done") onToggleDone();
        else if (a === "tomorrow") onTomorrow();
      }}
      style={({ pressed }) => [styles.row, compact && styles.compact, { backgroundColor: pressed ? colors.accentSoft : colors.surface }]}
    >
      <Pressable onPress={tick} hitSlop={(touchTarget - 26) / 2} accessibilityRole="checkbox" accessibilityState={{ checked: done }} accessibilityLabel={t(done ? "today.untick" : "today.tick", { title: task.title })}>
        <Animated.View style={[styles.tick, { borderColor: done ? colors.success.fg : overdue ? colors.danger.fg : colors.textTertiary, backgroundColor: done ? colors.success.fg : "transparent" }, tickStyle]}>
          {done ? <Icon name="check" size={15} color={colors.onAccent} strokeWidth={2.4} /> : null}
        </Animated.View>
      </Pressable>
      <View style={styles.body}>
        <HighlightText text={task.title} query={query} numberOfLines={2} style={[styles.title, { color: done ? colors.textTertiary : colors.text }, done && styles.struck]} />
        {meta || started || task.pendingSync ? (
          <View style={styles.metaRow}>
            {categoryColor ? <Dot color={categoryColor} size={6} /> : null}
            <Text variant="caption" numberOfLines={1} style={[styles.flex, { color: overdue ? colors.danger.fg : colors.textSecondary }]}>
              {[started ? t("status.IN_PROGRESS") : null, meta, task.pendingSync ? t("detail.pending") : null].filter(Boolean).join(" · ")}
            </Text>
          </View>
        ) : null}
        {progress > 0 && !done ? (
          <View style={[styles.progress, { backgroundColor: colors.chartGrid }]}>
            <View style={{ width: `${progress}%`, height: "100%", backgroundColor: colors.accent, borderRadius: 2 }} />
          </View>
        ) : null}
        {stepCount && onToggleExpand ? (
          <Pressable onPress={onToggleExpand} hitSlop={10} accessibilityRole="button" style={styles.steps}>
            <Text variant="label" color="accent">
              {t(expanded ? "tasks.hideSteps" : "tasks.showSteps", { count: stepCount })}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {flag && !done ? <Icon name="flag" size={16} color={colors.priority[task.priority]} /> : null}
      {onStart && task.status === "PENDING" && !compact ? (
        <Pressable onPress={onStart} hitSlop={8} accessibilityRole="button" accessibilityLabel={t("task.startA11y", { title: task.title })} style={[styles.start, { backgroundColor: colors.accentSoft }]}>
          <Icon name="play" size={14} color={colors.accentStrong} />
        </Pressable>
      ) : null}
    </Pressable>
  );

  if (compact) return row;
  return (
    <ReanimatedSwipeable
      ref={ref}
      friction={1.6}
      leftThreshold={84}
      rightThreshold={84}
      overshootFriction={8}
      renderLeftActions={(p, x) => <SwipeAction progress={p} drag={x} side="left" color={colors.success.fg} icon="check" label={t(done ? "detail.reopen" : "tasks.swipe.done")} />}
      renderRightActions={(p, x) => <SwipeAction progress={p} drag={x} side="right" color={colors.warning.fg} icon="calendar" label={t("tasks.swipe.tomorrow")} />}
      onSwipeableOpen={(direction) => {
        ref.current?.close();
        if (direction === SwipeDirection.RIGHT) onToggleDone();
        else onTomorrow();
      }}
    >
      {row}
    </ReanimatedSwipeable>
  );
}

function SwipeAction({ progress, drag, side, color, icon, label }: { progress: SharedValue<number>; drag: SharedValue<number>; side: "left" | "right"; color: string; icon: "check" | "calendar"; label: string }) {
  const { colors } = useTheme();
  const iconStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(progress.value, [0, 0.6, 1], [0.6, 0.9, 1.15], Extrapolation.CLAMP) }],
    opacity: interpolate(Math.abs(drag.value), [0, 30], [0, 1], Extrapolation.CLAMP),
  }));
  return (
    <View style={[styles.action, { backgroundColor: color, justifyContent: side === "left" ? "flex-start" : "flex-end" }]}>
      <Animated.View style={[styles.actionInner, iconStyle]}>
        {side === "right" ? (
          <Text variant="label" style={{ color: colors.onAccent }}>
            {label}
          </Text>
        ) : null}
        <Icon name={icon} size={20} color={colors.onAccent} strokeWidth={2.2} />
        {side === "left" ? (
          <Text variant="label" style={{ color: colors.onAccent }}>
            {label}
          </Text>
        ) : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", gap: 14, paddingHorizontal: 16, paddingVertical: 14, minHeight: 64 },
  compact: { paddingVertical: 10, paddingStart: 52, minHeight: 52 },
  tick: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, alignItems: "center", justifyContent: "center", marginTop: 1 },
  body: { flex: 1, gap: 3 },
  title: { fontFamily: "Inter_500Medium", fontSize: 15, lineHeight: 21 },
  struck: { textDecorationLine: "line-through" },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  flex: { flex: 1 },
  progress: { height: 3, borderRadius: 2, marginTop: 4, overflow: "hidden", width: "60%" },
  steps: { marginTop: 4, alignSelf: "flex-start" },
  start: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  action: { flex: 1, flexDirection: "row", alignItems: "center", paddingHorizontal: 24 },
  actionInner: { flexDirection: "row", alignItems: "center", gap: 8 },
});
