import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { Extrapolation, FadeIn, interpolate, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming, ZoomIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "../../components/icons/Icon";
import { DatePickerSheet } from "../../components/pickers/PickerSheets";
import { Button, Dot, IconButton, PressableScale, Snackbar, Text } from "../../components/primitives";
import { useLocalTasks } from "../../hooks/useDayData";
import { useLocale } from "../../i18n/LocaleProvider";
import type { StringKey } from "../../i18n/strings";
import type { MainStackParamList } from "../../navigation/MainStack";
import { hapticDone, hapticTap, hapticWarn } from "../../services/haptics";
import { deleteTask, restoreTask, updateTask, type TaskChanges } from "../../services/tasksApi";
import { useTheme } from "../../theme/ThemeProvider";
import { withAlpha } from "../../theme/tokens";
import type { Task } from "../../types/models";
import { catchUpChange, catchUpQueue, moveDate, type CatchUpMove } from "../../utils/catchUp";
import { formatDue, formatDuration } from "../../utils/format";
import { parseYmd } from "../../utils/pickers";

type Props = NativeStackScreenProps<MainStackParamList, "CatchUp">;
const FLING = 110;

/**
 * Catch up (UI v3, docs/design.md "Catch up"): overdue tasks one at a time on a card. Swipe right = done, left =
 * tomorrow; or Today / Tomorrow / Next week / Pick a date / Done / Drop it / Skip. The card flies off, the next rises
 * from behind; every choice has Undo; a finish screen when nothing is left. Changes save to the phone's store first.
 */
export function CatchUpScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { colors, spacing, radii, elevation, motion } = useTheme();
  const { t } = useLocale();
  const reduce = useReducedMotion();
  const tasks = useLocalTasks();
  // The queue is fixed when the screen opens (so finished cards don't come back); skipped ones go to the end.
  const [queue, setQueue] = useState<Task[] | null>(null);
  const total = useRef(0);
  const [handled, setHandled] = useState(0);
  const [picking, setPicking] = useState(false);
  const [snack, setSnack] = useState<{ text: string; undo?: () => void } | null>(null);
  useEffect(() => {
    if (queue === null && tasks.length) {
      const q = catchUpQueue(tasks);
      total.current = q.length;
      setQueue(q);
    }
  }, [tasks, queue]);

  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const current = queue?.[0] ?? null;
  const next = queue?.[1] ?? null;
  const third = queue?.[2] ?? null;

  const advance = (skip = false) => {
    x.value = 0;
    y.value = 0;
    setQueue((q) => (q ? (skip && q.length > 1 ? [...q.slice(1), q[0]] : q.slice(1)) : q));
    if (!skip) setHandled((n) => n + 1);
  };

  const apply = async (task: Task, choice: CatchUpMove | "done" | "drop") => {
    const before: TaskChanges = { dueDate: task.dueDate, dueTime: task.dueTime, scheduledStart: task.scheduledStart ?? null, scheduledEnd: task.scheduledEnd ?? null };
    const back = () => {
      setQueue((q) => (q ? [task, ...q] : [task]));
      setHandled((n) => Math.max(0, n - 1));
    };
    if (choice === "done") {
      hapticDone();
      await updateTask(task.id, { status: "COMPLETED" });
      setSnack({ text: t("catch.doneToast", { title: task.title }), undo: () => void updateTask(task.id, { status: task.status }).then(back) });
      return;
    }
    if (choice === "drop") {
      hapticWarn();
      await deleteTask(task.id);
      setSnack({ text: t("catch.dropped", { title: task.title }), undo: () => void restoreTask(task.id).then(back) });
      return;
    }
    hapticTap();
    await updateTask(task.id, catchUpChange(task, choice));
    const key: StringKey = choice === "today" ? "catch.movedToday" : choice === "tomorrow" ? "catch.movedTomorrow" : choice === "nextWeek" ? "catch.movedNextWeek" : "catch.movedDay";
    const day = (parseYmd(moveDate(choice)) ?? new Date()).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
    setSnack({ text: t(key, { title: task.title, day }), undo: () => void updateTask(task.id, before).then(back) });
  };

  /** Animate the card away (right = done, left = tomorrow, down = anything else), then save. */
  const decide = (choice: CatchUpMove | "done" | "drop") => {
    if (!current) return;
    const task = current;
    const dir = choice === "done" ? 1 : choice === "tomorrow" ? -1 : 0;
    const finish = () => {
      advance();
      void apply(task, choice);
    };
    if (reduce) return finish();
    if (dir) x.value = withTiming(dir * 520, { duration: motion.duration.base }, (ok) => ok && runOnJS(finish)());
    else y.value = withTiming(720, { duration: motion.duration.base }, (ok) => ok && runOnJS(finish)());
  };

  const pan = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .onUpdate((e) => {
      x.value = e.translationX;
      y.value = e.translationY * 0.25;
    })
    .onEnd((e) => {
      if (e.translationX > FLING || e.velocityX > 900) runOnJS(decide)("done");
      else if (e.translationX < -FLING || e.velocityX < -900) runOnJS(decide)("tomorrow");
      else {
        x.value = withSpring(0, motion.spring.snappy);
        y.value = withSpring(0, motion.spring.snappy);
      }
    });

  const topStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { rotate: `${interpolate(x.value, [-300, 300], [-12, 12], Extrapolation.CLAMP)}deg` }],
  }));
  const doneBadge = useAnimatedStyle(() => ({ opacity: interpolate(x.value, [20, FLING], [0, 1], Extrapolation.CLAMP) }));
  const laterBadge = useAnimatedStyle(() => ({ opacity: interpolate(x.value, [-FLING, -20], [1, 0], Extrapolation.CLAMP) }));
  const lift = useAnimatedStyle(() => {
    const p = Math.min(1, Math.abs(x.value) / FLING + y.value / 300);
    return { transform: [{ scale: 0.94 + 0.06 * p }, { translateY: 14 - 14 * p }], opacity: 0.7 + 0.3 * p };
  });

  const progress = total.current ? Math.min(1, handled / total.current) : 0;
  const done = queue !== null && queue.length === 0;

  const actions: Array<{ key: CatchUpMove | "pick"; label: StringKey; icon: IconName }> = useMemo(
    () => [
      { key: "today", label: "catch.today", icon: "today" },
      { key: "tomorrow", label: "catch.tomorrow", icon: "calendar" },
      { key: "nextWeek", label: "catch.nextWeek", icon: "plan" },
      { key: "pick", label: "catch.pick", icon: "chevronDown" },
    ],
    [],
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.canvas, paddingTop: insets.top + 4, paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
      <View style={styles.top}>
        <IconButton icon={<Icon name="close" size={22} color={colors.text} />} onPress={() => navigation.goBack()} accessibilityLabel={t("common.close")} />
        <View style={[styles.flex, { gap: 6 }]}>
          <View style={styles.row}>
            <Text variant="headline" style={styles.flex}>
              {t("catch.title")}
            </Text>
            {!done && total.current ? (
              <Text variant="label" color="secondary" tabular>
                {t("catch.progress", { n: Math.min(handled + 1, total.current), total: total.current })}
              </Text>
            ) : null}
          </View>
          <View style={[styles.track, { backgroundColor: colors.chartGrid }]}>
            <Animated.View style={[styles.fill, { width: `${progress * 100}%`, backgroundColor: colors.success.fg }]} />
          </View>
        </View>
      </View>

      {done ? (
        <View style={styles.finish}>
          <Animated.View entering={reduce ? undefined : ZoomIn.springify().damping(12)} style={[styles.finishIcon, { backgroundColor: colors.success.bg }]}>
            <Icon name="check" size={48} color={colors.success.fg} strokeWidth={2.4} />
          </Animated.View>
          <Text variant="title1" center>
            {t("catch.allDone")}
          </Text>
          <Text variant="callout" color="secondary" center>
            {t("catch.allDoneText")}
          </Text>
          <Button title={t("catch.back")} onPress={() => navigation.goBack()} style={{ marginTop: spacing.lg, alignSelf: "stretch" }} />
        </View>
      ) : (
        <>
          <View style={styles.deck}>
            {third ? <View style={[styles.card, elevation(1), { borderRadius: radii.xl, transform: [{ scale: 0.88 }, { translateY: 28 }], opacity: 0.5 }]} /> : null}
            {next ? (
              <Animated.View style={[styles.card, elevation(1), { borderRadius: radii.xl }, lift]}>
                <CardBody task={next} />
              </Animated.View>
            ) : null}
            {current ? (
              <GestureDetector gesture={pan}>
                <Animated.View key={current.id} entering={reduce ? undefined : FadeIn.duration(120)} style={[styles.card, elevation(2), { borderRadius: radii.xl }, topStyle]} accessible accessibilityHint={t("catch.hint")}>
                  <CardBody task={current} />
                  <Animated.View pointerEvents="none" style={[styles.badge, styles.badgeLeft, { borderColor: colors.success.fg, backgroundColor: withAlpha(colors.success.fg, 0.1) }, doneBadge]}>
                    <Text variant="headline" style={{ color: colors.success.fg }}>
                      {t("catch.done").toUpperCase()}
                    </Text>
                  </Animated.View>
                  <Animated.View pointerEvents="none" style={[styles.badge, styles.badgeRight, { borderColor: colors.warning.fg, backgroundColor: withAlpha(colors.warning.fg, 0.1) }, laterBadge]}>
                    <Text variant="headline" style={{ color: colors.warning.fg }}>
                      {t("catch.tomorrow").toUpperCase()}
                    </Text>
                  </Animated.View>
                </Animated.View>
              </GestureDetector>
            ) : null}
          </View>

          {/* The buttons stay at the bottom, in thumb reach. */}
          <View style={styles.flex} />
          <Text variant="caption" color="tertiary" center style={{ marginBottom: spacing.md }}>
            {t("catch.hint")}
          </Text>
          <View style={[styles.grid, { gap: spacing.sm }]}>
            {actions.map((a) => (
              <PressableScale
                key={typeof a.key === "string" ? a.key : "pick"}
                onPress={() => (a.key === "pick" ? setPicking(true) : decide(a.key))}
                accessibilityRole="button"
                style={[styles.action, { backgroundColor: colors.surface, borderColor: colors.hairline, borderRadius: radii.lg }]}
              >
                <Icon name={a.icon} size={20} color={colors.accentStrong} />
                <Text variant="label" numberOfLines={1}>
                  {t(a.label)}
                </Text>
              </PressableScale>
            ))}
          </View>
          <View style={[styles.row, { gap: spacing.sm, marginTop: spacing.sm }]}>
            <Button title={t("catch.drop")} kind="ghost" icon={<Icon name="trash" size={16} color={colors.danger.fg} />} onPress={() => decide("drop")} style={styles.flex} />
            <Button title={t("catch.skip")} kind="secondary" onPress={() => advance(true)} style={styles.flex} />
            <Button title={t("catch.done")} icon={<Icon name="check" size={16} color={colors.onAccent} />} onPress={() => decide("done")} style={styles.flex} />
          </View>
        </>
      )}

      <Snackbar text={snack?.text ?? null} action={snack?.undo ? { label: t("home.undo"), onPress: snack.undo } : undefined} onHide={() => setSnack(null)} />
      <DatePickerSheet visible={picking} onClose={() => setPicking(false)} ymd="" onPick={(ymd) => decide({ ymd })} title={t("catch.pick")} />
    </View>
  );
}

function CardBody({ task }: { task: Task }) {
  const { colors, spacing, radii } = useTheme();
  const { t } = useLocale();
  const due = Date.parse(task.dueAt ?? task.dueDate ?? "");
  const days = Number.isNaN(due) ? 0 : Math.floor((Date.now() - due) / 86400000);
  const facts: Array<{ icon: IconName; text: string }> = [
    ...(days >= 1 ? [{ icon: "clock" as IconName, text: days === 1 ? t("catch.waiting1") : t("catch.waiting", { days }) }] : []),
    ...(task.durationMinutes ? [{ icon: "layers" as IconName, text: t("catch.length", { time: formatDuration(task.durationMinutes) }) }] : []),
    ...(task.source !== "MANUAL" ? [{ icon: "sparkle" as IconName, text: t("catch.from", { source: task.source.charAt(0) + task.source.slice(1).toLowerCase() }) }] : []),
  ];
  return (
    <View style={{ flex: 1, padding: spacing.xl, gap: spacing.md }}>
      <View style={[styles.row, { gap: spacing.sm }]}>
        <Dot color={colors.priority[task.priority]} size={10} />
        <Text variant="label" color="secondary">
          {t(`prio.${task.priority}` as StringKey)}
        </Text>
        {task.category ? (
          <View style={[styles.tag, { backgroundColor: colors.skeleton, borderRadius: radii.pill }]}>
            <Text variant="label" color="secondary" style={{ fontSize: 11 }}>
              {task.category}
            </Text>
          </View>
        ) : null}
      </View>
      <Text variant="display" numberOfLines={4}>
        {task.title}
      </Text>
      <View style={[styles.row, { gap: 6 }]}>
        <Icon name="clock" size={16} color={colors.danger.fg} />
        <Text variant="callout" style={{ color: colors.danger.fg }}>
          {t("catch.wasDue", { when: formatDue(task).replace(/^Due\s+/i, "") })}
        </Text>
      </View>
      {facts.length ? (
        <View style={{ gap: spacing.sm, marginTop: spacing.xs }}>
          {facts.map((f) => (
            <View key={f.text} style={[styles.row, { gap: spacing.sm }]}>
              <Icon name={f.icon} size={16} color={colors.textTertiary} />
              <Text variant="callout" color="secondary">
                {f.text}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {task.description ? (
        <Text variant="callout" color="secondary" numberOfLines={4}>
          {task.description}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 20 },
  top: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 16 },
  row: { flexDirection: "row", alignItems: "center" },
  flex: { flex: 1 },
  track: { height: 6, borderRadius: 3, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 3 },
  deck: { flex: 1, maxHeight: 440, marginBottom: 16, marginTop: 8 },
  card: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  badge: { position: "absolute", top: 24, borderWidth: 2, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 4 },
  badgeLeft: { left: 24, transform: [{ rotate: "-10deg" }] },
  badgeRight: { right: 24, transform: [{ rotate: "10deg" }] },
  tag: { paddingHorizontal: 10, paddingVertical: 3 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  action: { width: "48%", flexGrow: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 52, borderWidth: StyleSheet.hairlineWidth },
  finish: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 12 },
  finishIcon: { width: 96, height: 96, borderRadius: 48, alignItems: "center", justifyContent: "center", marginBottom: 8 },
});
