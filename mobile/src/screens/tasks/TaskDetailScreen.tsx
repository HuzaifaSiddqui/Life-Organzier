import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import Animated, { FadeIn, FadeInDown, LinearTransition, useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "../../components/icons/Icon";
import { LockedFeature } from "../../components/LockedFeature";
import { Button, Card, Chip, Dot, ErrorState, IconButton, ListItem, PressableScale, Sheet, Skeleton, Snackbar, Text } from "../../components/primitives";
import { TaskLocationsField } from "../../components/TaskLocationsField";
import { ProgressBar } from "../../components/ui";
import { platformFeatures } from "../../constants/platformFeatures";
import { usePreferences } from "../../context/PreferencesContext";
import { useLocale } from "../../i18n/LocaleProvider";
import type { StringKey } from "../../i18n/strings";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getApiErrorMessage } from "../../services/api";
import { sendToAssistant, startTaskNow } from "../../services/assistantApi";
import { showAlert } from "../../services/dialog";
import { hapticDone, hapticTap, hapticWarn } from "../../services/haptics";
import { isLocalId } from "../../services/syncEngine";
import { createTask, deleteTask, getTask, splitTask, suggestSlot, undoTaskEdit, updateTask } from "../../services/tasksApi";
import { useTheme } from "../../theme/ThemeProvider";
import type { Task } from "../../types/models";
import { formatDue, formatDuration, formatTime, isOverdue } from "../../utils/format";

type Props = NativeStackScreenProps<MainStackParamList, "TaskDetail">;

/**
 * UI v3 task detail (docs/design.md "Task detail"): the task at a glance (priority, title, status, a facts list with
 * icons), what to do when it's overdue, progress, steps, finding time; Start and Mark done in a bar at the bottom
 * within thumb reach; rarer actions (undo, archive, ask the assistant, delete) under "⋯".
 */
export function TaskDetailScreen({ navigation, route }: Props) {
  const { taskId } = route.params;
  const insets = useSafeAreaInsets();
  const { colors, spacing, radii, elevation } = useTheme();
  const { t } = useLocale();
  const reduce = useReducedMotion();
  const { isPro } = usePreferences();
  const [task, setTask] = useState<Task | null>(null);
  const [subtasks, setSubtasks] = useState<Task[]>([]);
  const [parent, setParent] = useState<{ id: string; title: string } | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [slot, setSlot] = useState<{ start: string; end: string; reason: string } | null>(null);
  const [newSub, setNewSub] = useState("");
  const [menu, setMenu] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await getTask(taskId);
      setTask(r.task);
      setSubtasks(r.subtasks);
      setParent(r.parent);
      setCanUndo(r.canUndo);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [taskId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    try {
      const msg = await fn();
      if (msg) setToast(msg);
      await load();
    } catch (e) {
      setToast(getApiErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const viaAssistant = (key: string, payload: Record<string, unknown> & { type: string }, label: string) =>
    run(key, async () => {
      const reply = await sendToAssistant({ payload, label });
      return reply.message.content.split("\n")[0];
    });

  const topBar = (right?: ReactNode) => (
    <View style={[styles.topBar, { paddingTop: insets.top + 4, backgroundColor: colors.canvas, borderBottomColor: colors.hairline }]}>
      <IconButton icon={<Icon name="back" size={22} color={colors.text} />} onPress={() => navigation.goBack()} accessibilityLabel={t("common.back")} />
      <View style={styles.flex} />
      {right}
    </View>
  );

  if (error && !task) {
    return (
      <View style={[styles.root, { backgroundColor: colors.canvas }]}>
        {topBar()}
        <View style={{ padding: spacing.lg }}>
          <ErrorState error={error} onRetry={() => void load()} />
        </View>
      </View>
    );
  }
  if (!task) {
    return (
      <View style={[styles.root, { backgroundColor: colors.canvas }]}>
        {topBar()}
        <View style={{ padding: spacing.xl, gap: spacing.lg }}>
          <Skeleton height={20} width="40%" />
          <Skeleton height={36} />
          <Skeleton height={160} radius={radii.lg} />
          <Skeleton height={120} radius={radii.lg} />
        </View>
      </View>
    );
  }

  const done = task.status === "COMPLETED";
  const started = task.status === "IN_PROGRESS";
  const overdue = isOverdue(task);
  const progress = task.progress ?? 0;
  const canStart = task.status === "PENDING" && !isLocalId(task.id);
  const enter = (i: number) => (reduce ? undefined : FadeInDown.delay(40 * i).duration(220));
  const layout = reduce ? undefined : LinearTransition.springify().damping(22);

  const facts: Array<{ icon: IconName; label: string; value: string; danger?: boolean }> = [
    { icon: "calendar", label: t(task.scheduledStart ? "detail.deadline" : "detail.due"), value: task.scheduledStart && task.dueAt ? new Date(task.dueAt).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : task.dueAt || task.dueDate ? formatDue(task) : t("detail.noDue"), danger: overdue },
    ...(task.scheduledStart
      ? [{ icon: "clock" as IconName, label: t("detail.planned"), value: `${new Date(task.scheduledStart).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${formatTime(task.scheduledStart)}${task.scheduledEnd ? `–${formatTime(task.scheduledEnd)}` : ""}` }]
      : []),
    ...(task.durationMinutes ? [{ icon: "clock" as IconName, label: t("detail.length"), value: formatDuration(task.durationMinutes) }] : []),
    ...(task.category ? [{ icon: "layers" as IconName, label: t("detail.category"), value: task.category }] : []),
    ...(task.taskType ? [{ icon: "flag" as IconName, label: t("detail.type"), value: task.taskType.charAt(0) + task.taskType.slice(1).toLowerCase().replace(/_/g, " ") }] : []),
    ...(task.locationContext ? [{ icon: "pin" as IconName, label: t("detail.place"), value: task.locationContext }] : []),
    ...(Array.isArray(task.tags) && task.tags.length ? [{ icon: "tag" as IconName, label: t("detail.tags"), value: task.tags.map((x) => `#${x}`).join("  ") }] : []),
    ...(task.difficulty ? [{ icon: "pulse" as IconName, label: t("detail.difficulty"), value: `${task.difficulty}/5` }] : []),
    ...(task.source !== "MANUAL" ? [{ icon: "sparkle" as IconName, label: t("detail.source"), value: task.source.charAt(0) + task.source.slice(1).toLowerCase() }] : []),
  ];

  const toggleDone = () =>
    void run("done", async () => {
      await updateTask(task.id, { status: done ? "PENDING" : "COMPLETED" });
      if (!done) hapticDone();
      return t(done ? "detail.reopened" : "detail.doneToast");
    });

  const confirmDelete = () => {
    setMenu(false);
    hapticWarn();
    showAlert(t("detail.deleteQ", { title: task.title }), t("detail.deleteBody"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("detail.delete"),
        style: "destructive",
        onPress: async () => {
          await deleteTask(task.id);
          navigation.popTo("Tabs", { screen: "TaskList", params: { toast: t("detail.deleted", { title: task.title }) } });
        },
      },
    ]);
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.canvas }]}>
      {topBar(
        <>
          <IconButton icon={<Icon name="edit" size={20} color={colors.text} />} onPress={() => navigation.navigate("EditTask", { taskId: task.id })} accessibilityLabel={t("detail.edit")} />
          <IconButton icon={<Icon name="more" size={24} color={colors.text} strokeWidth={3} />} onPress={() => setMenu(true)} accessibilityLabel={t("detail.more")} />
        </>,
      )}
      <ScrollView contentContainerStyle={[styles.content, { gap: spacing.lg, paddingBottom: insets.bottom + 120 }]} showsVerticalScrollIndicator={false}>
        {/* Title block */}
        <Animated.View entering={enter(0)} style={{ gap: spacing.sm }}>
          {parent ? (
            <PressableScale onPress={() => navigation.push("TaskDetail", { taskId: parent.id })} accessibilityRole="link" style={styles.row}>
              <Icon name="back" size={14} color={colors.accentStrong} />
              <Text variant="label" color="accent">
                {t("detail.partOf", { title: parent.title })}
              </Text>
            </PressableScale>
          ) : null}
          <View style={[styles.row, { gap: spacing.sm }]}>
            <Dot color={colors.priority[task.priority]} size={10} />
            <Text variant="label" color="secondary">
              {t(`prio.${task.priority}` as StringKey)}
            </Text>
            <View style={[styles.status, { backgroundColor: done ? colors.success.bg : overdue ? colors.danger.bg : started ? colors.info.bg : colors.skeleton, borderRadius: radii.pill }]}>
              <Text variant="label" style={{ fontSize: 11, color: done ? colors.success.fg : overdue ? colors.danger.fg : started ? colors.info.fg : colors.textSecondary }}>
                {overdue && !done ? t("plan.overdue") : t(`status.${task.status}` as StringKey)}
              </Text>
            </View>
            {task.pendingSync ? (
              <Text variant="caption" color="tertiary">
                {t("detail.pending")}
              </Text>
            ) : null}
          </View>
          <Text variant="display" style={done ? { textDecorationLine: "line-through", color: colors.textTertiary } : undefined}>
            {task.title}
          </Text>
        </Animated.View>

        {/* Facts */}
        <Animated.View entering={enter(1)} layout={layout}>
          <Card style={styles.listCard}>
            {facts.map((f, i) => (
              <View key={f.label} style={[styles.fact, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline }]}>
                <View style={[styles.factIcon, { backgroundColor: f.danger ? colors.danger.bg : colors.accentSoft, borderRadius: radii.sm }]}>
                  <Icon name={f.icon} size={16} color={f.danger ? colors.danger.fg : colors.accentStrong} />
                </View>
                <Text variant="callout" color="secondary" style={styles.factLabel}>
                  {f.label}
                </Text>
                <Text variant="bodyStrong" style={[styles.flex, { textAlign: "right" }, f.danger && { color: colors.danger.fg }]}>
                  {f.value}
                </Text>
              </View>
            ))}
          </Card>
        </Animated.View>

        {task.description ? (
          <Animated.View entering={enter(2)}>
            <Text variant="label" color="tertiary" style={styles.sectionLabel}>
              {t("detail.notes").toUpperCase()}
            </Text>
            <Card>
              <Text variant="body">{task.description}</Text>
            </Card>
          </Animated.View>
        ) : null}

        {task.sharedTaskId ? <ListItem title={t("collab.detail.shared")} subtitle={t("collab.detail.see")} leading={<Icon name="people" color={colors.accent} />} trailing={<Icon name="chevron" color={colors.textTertiary} />} onPress={() => navigation.navigate("Collab", { tab: "shared" })} /> : null}

        {overdue && !done ? (
          <Animated.View entering={enter(2)} layout={layout}>
            <Card tone="danger" style={{ gap: spacing.md }}>
              <Text variant="callout">{t("detail.overdueQ")}</Text>
              <View style={styles.wrap}>
                <Chip small selected label={t("action.doItNow")} onPress={() => void viaAssistant("od", { type: "overdue_action", taskId: task.id, choice: "complete_now" }, t("action.doItNow"))} />
                <Chip small label={t("detail.couldnt")} onPress={() => void viaAssistant("od", { type: "overdue_action", taskId: task.id, choice: "couldnt" }, t("detail.couldnt"))} />
                <Chip small label={t("detail.extension")} onPress={() => navigation.navigate("Assistant", { payload: { type: "overdue_action", taskId: task.id, choice: "extension" }, label: t("detail.extension"), nonce: Date.now() })} />
                <Chip small label={t("detail.planFinish")} onPress={() => navigation.navigate("Assistant", { payload: { type: "overdue_action", taskId: task.id, choice: "plan" }, label: t("detail.planFinish"), nonce: Date.now() })} />
              </View>
            </Card>
          </Animated.View>
        ) : null}

        {/* Progress */}
        <Animated.View entering={enter(3)} layout={layout}>
          <Text variant="label" color="tertiary" style={styles.sectionLabel}>
            {t("detail.progress").toUpperCase()}
          </Text>
          <Card style={{ gap: spacing.md }}>
            <View style={styles.row}>
              <Text variant="title2" tabular style={styles.flex}>
                {progress}%
              </Text>
              <Text variant="caption" color="secondary">
                {subtasks.length ? t("detail.progressParts", { pct: progress, count: subtasks.length }) : t("detail.progressPct", { pct: progress })}
              </Text>
            </View>
            <ProgressBar value={progress} color={done ? colors.success.fg : colors.accent} height={8} />
            {task.progressUpdatedBy ? (
              <Text variant="caption" color="tertiary">
                {t("collab.progress.updatedBy", { name: task.progressUpdatedBy })}
              </Text>
            ) : null}
            {!subtasks.length ? (
              <View style={styles.wrap}>
                {[0, 25, 50, 75, 100].map((p) => (
                  <Chip
                    key={p}
                    small
                    label={`${p}%`}
                    selected={progress === p}
                    onPress={() =>
                      void run("p", async () => {
                        hapticTap();
                        await updateTask(task.id, { progress: p });
                        if (p === 100) hapticDone();
                      })
                    }
                  />
                ))}
              </View>
            ) : null}
          </Card>
        </Animated.View>

        {/* Steps */}
        <Animated.View entering={enter(4)} layout={layout}>
          <View style={[styles.row, styles.sectionLabel]}>
            <Text variant="label" color="tertiary" style={styles.flex}>
              {t("detail.steps").toUpperCase()}
            </Text>
            {!task.parentTaskId ? (
              <Chip
                small
                leading={<Icon name="sparkle" size={14} color={colors.accentStrong} />}
                label={busy === "split" ? t("detail.splitting") : t("detail.split")}
                onPress={() =>
                  void run("split", async () => {
                    const r = await splitTask(task.id);
                    return t("detail.splitDone", { count: r.subtasks.length });
                  })
                }
              />
            ) : null}
          </View>
          <Card style={styles.listCard}>
            {subtasks.map((s) => {
              const sDone = s.status === "COMPLETED";
              return (
                <Animated.View key={s.id} entering={reduce ? undefined : FadeIn} layout={layout} style={[styles.step, { borderBottomColor: colors.hairline }]}>
                  <PressableScale
                    onPress={() =>
                      void run(`s-${s.id}`, async () => {
                        if (!sDone) hapticDone();
                        await updateTask(s.id, { status: sDone ? "PENDING" : "COMPLETED" });
                      })
                    }
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: sDone }}
                    accessibilityLabel={t(sDone ? "today.untick" : "today.tick", { title: s.title })}
                    hitSlop={10}
                    style={[styles.tick, { borderColor: sDone ? colors.success.fg : colors.textTertiary, backgroundColor: sDone ? colors.success.fg : "transparent" }]}
                  >
                    {sDone ? <Icon name="check" size={14} color={colors.onAccent} strokeWidth={2.4} /> : null}
                  </PressableScale>
                  <PressableScale scale={false} style={styles.flex} onPress={() => navigation.push("TaskDetail", { taskId: s.id })} accessibilityRole="button">
                    <Text variant="body" style={sDone ? { textDecorationLine: "line-through", color: colors.textTertiary } : undefined}>
                      {s.title}
                    </Text>
                    {s.durationMinutes || s.dueAt ? (
                      <Text variant="caption" color="tertiary">
                        {[s.dueAt ? formatDue(s) : null, s.durationMinutes ? formatDuration(s.durationMinutes) : null].filter(Boolean).join(" · ")}
                      </Text>
                    ) : null}
                  </PressableScale>
                </Animated.View>
              );
            })}
            <View style={styles.step}>
              <Icon name="plus" size={20} color={colors.textTertiary} />
              <TextInput
                value={newSub}
                onChangeText={setNewSub}
                placeholder={t("detail.addStep")}
                placeholderTextColor={colors.textTertiary}
                returnKeyType="done"
                style={[styles.flex, styles.input, { color: colors.text }]}
                onSubmitEditing={() => {
                  const title = newSub.trim();
                  if (!title) return;
                  setNewSub("");
                  void run("add", async () => {
                    await createTask({ title, priority: task.priority, category: task.category, source: "MANUAL", parentTaskId: task.id, dueDate: task.dueDate, dueTime: task.dueTime });
                  });
                }}
              />
            </View>
          </Card>
        </Animated.View>

        {/* Find time */}
        {!done ? (
          <Animated.View entering={enter(5)} layout={layout}>
            <Text variant="label" color="tertiary" style={styles.sectionLabel}>
              {t("detail.schedule").toUpperCase()}
            </Text>
            <Card style={{ gap: spacing.md }}>
              {slot ? (
                <>
                  <Text variant="callout">{slot.reason}</Text>
                  <View style={styles.wrap}>
                    <Button
                      title={t("detail.book")}
                      size="sm"
                      onPress={() =>
                        void run("book", async () => {
                          await updateTask(task.id, { scheduledStart: slot.start, scheduledEnd: slot.end });
                          setSlot(null);
                          hapticDone();
                          return t("detail.booked");
                        })
                      }
                    />
                    <Button title={t("today.notNow")} size="sm" kind="ghost" onPress={() => setSlot(null)} />
                  </View>
                </>
              ) : (
                <>
                  {!task.scheduledStart ? (
                    <Text variant="callout" color="secondary">
                      {t("detail.notScheduled")}
                    </Text>
                  ) : null}
                  <View style={styles.wrap}>
                    <Button
                      title={busy === "slot" ? t("detail.finding") : t("detail.findTime")}
                      size="sm"
                      kind="tonal"
                      icon={<Icon name="sparkle" size={16} color={colors.accentStrong} />}
                      loading={busy === "slot"}
                      onPress={() =>
                        void run("slot", async () => {
                          const s = await suggestSlot(task.id);
                          if (!s) return t("detail.noSlot");
                          setSlot(s);
                        })
                      }
                    />
                    {(task.durationMinutes ?? 0) >= 90 ? <Button title={t("detail.chunks")} size="sm" kind="secondary" onPress={() => void viaAssistant("chunk", { type: "chunk_task", taskId: task.id }, t("detail.chunks"))} /> : null}
                  </View>
                </>
              )}
            </Card>
          </Animated.View>
        ) : null}

        {platformFeatures.locationReminders && !isLocalId(task.id) ? (
          <LockedFeature feature="locationReminders" name={t("lock.name.location")}>
            <TaskLocationsField key={task.updatedAt} taskId={task.id} initial={isPro ? (task.locations ?? []) : []} showDistance />
          </LockedFeature>
        ) : null}
      </ScrollView>

      {/* Thumb-reach actions */}
      <View style={[styles.bottomBar, elevation(2), { paddingBottom: Math.max(insets.bottom, spacing.md), borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl, gap: spacing.sm }]}>
        {canStart ? (
          <Button
            title={t("detail.start")}
            kind="secondary"
            icon={<Icon name="play" size={18} color={colors.text} />}
            loading={busy === "start"}
            style={styles.flex}
            onPress={() => {
              hapticTap();
              void run("start", () => startTaskNow(task.id));
            }}
          />
        ) : null}
        <Button
          title={t(done ? "detail.reopen" : "detail.markDone")}
          kind={done ? "secondary" : "primary"}
          icon={<Icon name={done ? "undo" : "check"} size={18} color={done ? colors.text : colors.onAccent} />}
          loading={busy === "done"}
          style={styles.flex}
          onPress={toggleDone}
        />
      </View>

      <Snackbar text={toast} onHide={() => setToast(null)} />

      <Sheet visible={menu} onClose={() => setMenu(false)}>
        {canUndo ? (
          <ListItem
            title={t("detail.undo")}
            leading={<Icon name="undo" color={colors.textSecondary} />}
            onPress={() => {
              setMenu(false);
              void run("undo", async () => {
                await undoTaskEdit(task.id);
                return t("detail.undone");
              });
            }}
          />
        ) : null}
        <ListItem
          title={t("detail.discuss")}
          leading={<Icon name="sparkle" color={colors.textSecondary} />}
          onPress={() => {
            setMenu(false);
            navigation.navigate("Assistant", { prefill: `About "${task.title}": `, nonce: Date.now() });
          }}
        />
        {done ? (
          <ListItem
            title={t("detail.archive")}
            leading={<Icon name="archive" color={colors.textSecondary} />}
            onPress={() => {
              setMenu(false);
              void run("arch", async () => {
                await updateTask(task.id, { archived: true });
                navigation.goBack();
              });
            }}
          />
        ) : null}
        <ListItem title={t("detail.delete")} leading={<Icon name="trash" color={colors.danger.fg} />} onPress={confirmDelete} />
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingBottom: 4, gap: 4, zIndex: 2 },
  content: { paddingHorizontal: 20, paddingTop: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  flex: { flex: 1 },
  status: { paddingHorizontal: 10, paddingVertical: 3 },
  listCard: { padding: 0, overflow: "hidden" },
  fact: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, minHeight: 52 },
  factIcon: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  factLabel: { minWidth: 88 },
  sectionLabel: { marginBottom: 8 },
  step: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth },
  tick: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  input: { fontSize: 15, minHeight: 48 },
  bottomBar: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", paddingHorizontal: 16, paddingTop: 12 },
});
