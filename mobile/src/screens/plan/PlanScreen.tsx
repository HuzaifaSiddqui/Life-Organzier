import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FloatingAddButton } from "../../components/FloatingAddButton";
import { Icon } from "../../components/icons/Icon";
import { clockLabel } from "../../components/plan/clock";
import { MonthView } from "../../components/plan/MonthView";
import { PlanTimeline } from "../../components/plan/PlanTimeline";
import type { DropMode } from "../../components/plan/TimelineTile";
import { WeekStrip } from "../../components/plan/WeekStrip";
import { Chip, IconButton, PressableScale, Segmented, Snackbar, SyncBadge, Text } from "../../components/primitives";
import { usePreferences } from "../../context/PreferencesContext";
import { useDayData } from "../../hooks/useDayData";
import { clock12Text, to12 } from "../../utils/pickers";
import { useLocale } from "../../i18n/LocaleProvider";
import type { MainStackParamList } from "../../navigation/MainStack";
import { showAlert } from "../../services/dialog";
import { hapticDone } from "../../services/haptics";
import { rescheduleOccurrence } from "../../services/routinesApi";
import { updateTask, type TaskChanges } from "../../services/tasksApi";
import { useTheme } from "../../theme/ThemeProvider";
import { tabBar } from "../../theme/tokens";
import { addDays, dayKey, itemsForDay, monthGrid, moveChange, parseClock, sameDay, startOfDay, weekOf, type DayPlan, type TimelineItem } from "../../utils/timeline";

type View3 = "day" | "week" | "month";
type Nav = NativeStackNavigationProp<MainStackParamList>;

/**
 * UI v3 Plan (docs/design.md "Plan"): the user's time, Google-Calendar style. Day / Week / Month; tasks and routines
 * together on a time grid with a live "now" line. Hold a block to move it (snaps to 15 min, days in Week view), drag
 * its bottom edge to change the length, tap it to open; tap an empty slot to add a task there. Every move has Undo.
 * Works offline: tasks from the phone's store, routines from the last saved copy.
 */
export function PlanScreen() {
  const navigation = useNavigation<Nav>();
  const { colors, spacing } = useTheme();
  const { t } = useLocale();
  const insets = useSafeAreaInsets();
  const reduce = useReducedMotion();
  const { settings } = usePreferences();
  const { tasks, routines, routinesQ, now } = useDayData();
  const [view, setView] = useState<View3>("day");
  const [selected, setSelected] = useState(() => startOfDay(new Date()));
  const [direction, setDirection] = useState(0);
  const [snack, setSnack] = useState<{ text: string; undo?: () => void } | null>(null);
  const [resetKey, setResetKey] = useState(0);

  const week = useMemo(() => weekOf(selected), [selected]);
  const days = view === "week" ? week : [selected];
  const plans = useMemo<DayPlan[]>(() => days.map((d) => itemsForDay(tasks, routines, d, now)), [days, tasks, routines, now]);
  const grid = useMemo(() => monthGrid(selected), [selected]);
  const monthPlans = useMemo(() => {
    if (view !== "month") return {};
    const out: Record<string, DayPlan> = {};
    for (const d of grid.flat()) out[dayKey(d)] = itemsForDay(tasks, routines, d, now);
    return out;
  }, [view, grid, tasks, routines, now]);
  const counts = useMemo(() => {
    const out: Record<string, { open: number; done: number; overdue: number }> = {};
    for (const d of week) {
      const p = itemsForDay(tasks, routines, d, now);
      const all = [...p.timed, ...p.allDay].filter((i) => !i.muted);
      out[dayKey(d)] = { open: all.filter((i) => !i.done).length, done: all.filter((i) => i.done).length, overdue: all.filter((i) => i.overdue).length };
    }
    return out;
  }, [week, tasks, routines, now]);

  const colorOf = useCallback(
    (i: TimelineItem) => {
      if (i.kind === "routine") return colors.category[1];
      if (!i.category) return colors.accent;
      let h = 0;
      for (const ch of i.category) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return colors.category[h % colors.category.length];
    },
    [colors],
  );

  const shiftDays = (n: number) => {
    setDirection(n);
    setSelected((d) => addDays(d, n));
  };
  const shiftMonths = (n: number) => {
    setDirection(n);
    setSelected((d) => startOfDay(new Date(d.getFullYear(), d.getMonth() + n, 1)));
  };
  const goToday = () => {
    const today = startOfDay(new Date());
    setDirection(today > selected ? 1 : -1);
    setSelected(today);
  };

  const openItem = (i: TimelineItem) => {
    if (i.kind === "task") navigation.navigate("TaskDetail", { taskId: i.id });
    else navigation.navigate("Routines", { routineId: i.routineId });
  };

  const addAt = (day: Date, minutes: number | null) => {
    // The form's time text ("2:00 PM"), as its fields and pickers show it.
    const time = minutes == null ? null : clock12Text(to12(Math.floor(minutes / 60), minutes % 60));
    navigation.navigate("AddTask", { prefill: { dueYmd: dayKey(day), dueTime: time } });
  };

  const drop = async (item: TimelineItem, day: Date, start: number, end: number, mode: DropMode) => {
    const task = item.kind === "task" ? tasks.find((x) => x.id === item.id) : undefined;
    const text = mode === "resize" ? t("plan.resized", { time: clockLabel(end) }) : t("plan.moved", { time: `${sameDay(day, selected) ? "" : `${day.toLocaleDateString([], { weekday: "short" })} `}${clockLabel(start)}` });
    try {
      if (item.kind === "task" && task) {
        const before: TaskChanges = { dueDate: task.dueDate, dueTime: task.dueTime, scheduledStart: task.scheduledStart ?? null, scheduledEnd: task.scheduledEnd ?? null, durationMinutes: task.durationMinutes ?? null };
        const change = moveChange(item, day, start, end);
        // A deadline block's length is the task's duration: resizing it changes only that.
        const changes: TaskChanges = mode === "resize" && item.anchor === "due" ? { durationMinutes: end - start } : change.kind === "task" ? { ...change.changes } : {};
        await updateTask(item.id, changes);
        hapticDone();
        setSnack({ text, undo: () => void updateTask(item.id, before) });
      } else if (item.kind === "routine") {
        const original = routines.flatMap((r) => r.occurrences.map((o) => ({ r, o }))).find((x) => x.o.id === item.id);
        const change = moveChange(item, day, start, end);
        if (change.kind !== "routine") return;
        const locked = Boolean(item.locked);
        const go = async () => {
          try {
            // Shown at once; the server answer replaces it.
            routinesQ.mutate((prev) => (prev ?? []).map((r) => ({ ...r, occurrences: r.occurrences.map((o) => (o.id === item.id ? { ...o, occurrenceDate: day.toISOString(), dueTime: change.time } : o)) })));
            await rescheduleOccurrence(item.id, change.date, change.time, locked);
            hapticDone();
            const old = original ? { date: dayKey(new Date(original.o.occurrenceDate)), time: original.o.dueTime ?? original.r.dueTime } : null;
            setSnack({ text, undo: old ? () => void rescheduleOccurrence(item.id, old.date, old.time, locked).then(() => routinesQ.reload()) : undefined });
          } catch {
            setSnack({ text: t("plan.moveFailed") });
            setResetKey((k) => k + 1);
          } finally {
            void routinesQ.reload();
          }
        };
        if (locked) {
          // A fixed-time routine (a class, prayer, work shift): move just this one, only when the user says so.
          const when = `${sameDay(day, selected) ? "" : `${day.toLocaleDateString([], { weekday: "short" })} `}${clockLabel(start)}`;
          showAlert(t("plan.lockedQ", { title: item.title }), t("plan.lockedBody", { when }), [
            { text: t("common.cancel"), style: "cancel", onPress: () => setResetKey((k) => k + 1) },
            { text: t("plan.moveOne"), onPress: () => void go() },
          ], { cancelable: true, onDismiss: () => setResetKey((k) => k + 1) });
          return;
        }
        await go();
      }
    } catch {
      setSnack({ text: t("plan.moveFailed") });
      setResetKey((k) => k + 1);
      void routinesQ.reload();
    }
  };

  const title = selected.toLocaleDateString([], { month: "long", year: selected.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  const isToday = sameDay(selected, now);
  const dayPlan = plans[0];
  // Overdue tasks sit on their own (past) days; on today they're one tap away instead of invisible.
  const overdueCount = useMemo(() => tasks.filter((x) => x.status !== "COMPLETED" && x.status !== "DELETED" && !x.archived && x.dueAt && new Date(x.dueAt) < startOfDay(now)).length, [tasks, now]);
  const showOverdue = isToday && overdueCount > 0;
  const workStart = parseClock(settings?.workStart) ?? 8 * 60;
  const workEnd = parseClock(settings?.workEnd) ?? 22 * 60;
  const bottom = insets.bottom + tabBar.height + 56;

  return (
    <View style={[styles.root, { paddingTop: insets.top, backgroundColor: colors.canvas }]}>
      <View style={[styles.header, { paddingHorizontal: spacing.lg, gap: spacing.md }]}>
        <View style={styles.titleRow}>
          <PressableScale
            onPress={() => setView((v) => (v === "month" ? "day" : "month"))}
            accessibilityRole="button"
            accessibilityLabel={title}
            style={styles.titleBtn}
          >
            <Text variant="title1" numberOfLines={1}>
              {title}
            </Text>
            <Icon name="chevronDown" size={20} color={colors.textSecondary} />
          </PressableScale>
          <SyncBadge />
          {!isToday || view === "month" ? <Chip label={t("plan.today")} onPress={goToday} /> : null}
          <IconButton icon={<Icon name="list" size={22} color={colors.text} />} onPress={() => navigation.navigate("TaskList")} accessibilityLabel={t("plan.list")} />
        </View>
        <Segmented
          accessibilityLabel={t("plan.title")}
          value={view}
          onChange={setView}
          options={[
            { value: "day", label: t("plan.view.day") },
            { value: "week", label: t("plan.view.week") },
            { value: "month", label: t("plan.view.month") },
          ]}
        />
        {view !== "month" ? <WeekStrip days={week} selected={selected} today={now} counts={counts} onPick={setSelected} onShift={(w) => shiftDays(w * 7)} direction={direction} /> : null}
        {/* Week view: untimed items per day as small counts; a tap opens that day. */}
        {view === "week" && plans.some((p) => p.allDay.filter((i) => !i.muted).length) ? (
          <View style={styles.weekAny}>
            {days.map((d, i) => {
              const n = plans[i].allDay.filter((x) => !x.muted && !x.done).length;
              return (
                <View key={d.toDateString()} style={styles.weekAnyCell}>
                  {n ? (
                    <PressableScale
                      onPress={() => {
                        setSelected(d);
                        setView("day");
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`${d.toLocaleDateString([], { weekday: "long" })}: ${t("plan.anyTimeCount", { count: n })}`}
                      style={[styles.anyPill, { backgroundColor: colors.accentSoft }]}
                    >
                      <Text variant="label" style={{ color: colors.accentStrong, fontSize: 11 }}>
                        {n}
                      </Text>
                    </PressableScale>
                  ) : null}
                </View>
              );
            })}
          </View>
        ) : null}
        {view === "day" && (dayPlan.allDay.length || showOverdue) ? (
          <Animated.View entering={reduce ? undefined : FadeIn.duration(160)} exiting={reduce ? undefined : FadeOut.duration(120)}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
              <Text variant="label" color="tertiary" style={styles.anyTime}>
                {t("plan.allDay")}
              </Text>
              {showOverdue ? <Chip small tone="danger" selected label={`${t("plan.overdue")} · ${overdueCount}`} onPress={() => navigation.navigate("TaskList", { filter: "overdue" })} /> : null}
              {dayPlan.allDay.map((i) => (
                <Chip key={i.key} small label={i.title} selected={!i.done} tone={i.overdue ? "danger" : "accent"} onPress={() => openItem(i)} />
              ))}
            </ScrollView>
          </Animated.View>
        ) : null}
      </View>
      <View style={[styles.body, { borderTopColor: colors.hairline }]}>
        {view === "month" ? (
          <MonthView
            month={selected}
            grid={grid}
            plans={monthPlans}
            today={now}
            selected={selected}
            colorOf={colorOf}
            onPick={(d) => {
              setSelected(d);
              setView("day");
            }}
            onShift={shiftMonths}
            bottomInset={bottom}
          />
        ) : (
          <PlanTimeline
            days={days}
            plans={plans}
            now={now}
            colorOf={colorOf}
            onTap={openItem}
            onDrop={(i, d, s, e, m) => void drop(i, d, s, e, m)}
            onSlot={addAt}
            freeFrom={workStart}
            freeTo={workEnd}
            bottomInset={bottom}
            resetKey={resetKey}
          />
        )}
      </View>
      {snack ? null : <FloatingAddButton onPress={() => addAt(selected, null)} />}
      <Snackbar text={snack?.text ?? null} action={snack?.undo ? { label: t("home.undo"), onPress: snack.undo } : undefined} onHide={() => setSnack(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { paddingTop: 8, paddingBottom: 8 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  titleBtn: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6, minHeight: 48 },
  anyTime: { alignSelf: "center", marginEnd: 4 },
  body: { flex: 1, borderTopWidth: StyleSheet.hairlineWidth },
  weekAny: { flexDirection: "row", marginTop: -4 },
  weekAnyCell: { flex: 1, alignItems: "center", minHeight: 24 },
  anyPill: { minWidth: 28, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
});
