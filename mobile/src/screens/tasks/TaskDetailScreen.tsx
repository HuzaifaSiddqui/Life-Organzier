import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Button, Card, Chip, ProgressBar, Snackbar, ui } from "../../components/ui";
import { colors, palette } from "../../constants/theme";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getApiErrorMessage } from "../../services/api";
import { sendToAssistant } from "../../services/assistantApi";
import { createTask, deleteTask, getTask, splitTask, suggestSlot, undoTaskEdit, updateTask } from "../../services/tasksApi";
import type { Task } from "../../types/models";
import { formatDue, formatDuration, formatTime, isOverdue } from "../../utils/format";
import { priorityPill } from "../../utils/priorityColors";

type Props = NativeStackScreenProps<MainStackParamList, "TaskDetail">;

export function TaskDetailScreen({ navigation, route }: Props) {
  const { taskId } = route.params;
  const [task, setTask] = useState<Task | null>(null);
  const [subtasks, setSubtasks] = useState<Task[]>([]);
  const [parent, setParent] = useState<{ id: string; title: string } | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [slot, setSlot] = useState<{ start: string; end: string; reason: string } | null>(null);
  const [newSub, setNewSub] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await getTask(taskId);
      setTask(r.task);
      setSubtasks(r.subtasks);
      setParent(r.parent);
      setCanUndo(r.canUndo);
      setError(null);
    } catch (e) {
      setError(getApiErrorMessage(e, "Could not load task."));
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

  if (error) {
    return (
      <View style={ui.screen}>
        <ScreenHeader title="Task" onBack={() => navigation.goBack()} />
        <Text style={[ui.error, { padding: 16 }]}>{error}</Text>
      </View>
    );
  }
  if (!task) {
    return (
      <View style={ui.screen}>
        <ScreenHeader title="Task" onBack={() => navigation.goBack()} />
        <ActivityIndicator style={{ marginTop: 40 }} color={palette.ai} />
      </View>
    );
  }

  const done = task.status === "COMPLETED";
  const overdue = isOverdue(task);
  const pill = priorityPill(task.priority);
  const progress = task.progress ?? 0;

  return (
    <View style={ui.screen}>
      <ScreenHeader
        title="Task"
        onBack={() => navigation.goBack()}
        right={
          <Pressable onPress={() => navigation.navigate("EditTask", { taskId: task.id })} hitSlop={10}>
            <Text style={styles.edit}>Edit</Text>
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={styles.content}>
        {parent ? (
          <Pressable onPress={() => navigation.push("TaskDetail", { taskId: parent.id })}>
            <Text style={styles.parent}>Part of “{parent.title}”</Text>
          </Pressable>
        ) : null}
        <Card style={{ gap: 10 }}>
          <Text style={[styles.title, done && { textDecorationLine: "line-through", color: colors.textMuted }]}>{task.title}</Text>
          <View style={ui.wrap}>
            <View style={[styles.badge, { backgroundColor: pill.backgroundColor }]}>
              <Text style={[styles.badgeText, { color: pill.color }]}>{task.priority}</Text>
            </View>
            <Chip small label={task.status.replace("_", " ")} />
            {task.category ? <Chip small label={task.category} /> : null}
            {task.taskType ? <Chip small label={task.taskType.toLowerCase()} /> : null}
            {task.locationContext ? <Chip small label={task.locationContext} /> : null}
            {task.pendingSync ? <Chip small label="⟳ pending sync" /> : null}
          </View>
          <Text style={[styles.meta, overdue && { color: palette.danger, fontFamily: "Inter_600SemiBold" }]}>{formatDue(task)}</Text>
          {task.scheduledStart && task.dueAt ? <Text style={styles.meta}>Deadline: {new Date(task.dueAt).toLocaleString()}</Text> : null}
          {task.durationMinutes ? <Text style={styles.meta}>Takes about {formatDuration(task.durationMinutes)}</Text> : null}
          {task.difficulty ? <Text style={styles.meta}>Difficulty {task.difficulty}/5</Text> : null}
          {Array.isArray(task.tags) && task.tags.length ? <Text style={styles.tags}>{task.tags.map((t) => `#${t}`).join("  ")}</Text> : null}
          {task.description ? <Text style={ui.body}>{task.description}</Text> : null}
          {task.source !== "MANUAL" ? <Text style={styles.meta}>Added via {task.source.toLowerCase()}{task.confidence ? ` · clarity ${task.confidence}%` : ""}</Text> : null}
        </Card>

        {overdue ? (
          <Card tone="danger" style={{ gap: 10 }}>
            <Text style={ui.body}>This is past its deadline and still pending. What would you like to do?</Text>
            <View style={ui.wrap}>
              <Chip small selected label="Complete now" onPress={() => void viaAssistant("od", { type: "overdue_action", taskId: task.id, choice: "complete_now" }, "Complete now")} />
              <Chip small label="I couldn't finish" onPress={() => void viaAssistant("od", { type: "overdue_action", taskId: task.id, choice: "couldnt" }, "I couldn't finish")} />
              <Chip small label="Need extension?" onPress={() => navigation.navigate("Assistant", { payload: { type: "overdue_action", taskId: task.id, choice: "extension" }, label: "Need an extension", nonce: Date.now() })} />
              <Chip small label="Plan finishing" onPress={() => navigation.navigate("Assistant", { payload: { type: "overdue_action", taskId: task.id, choice: "plan" }, label: "Plan finishing", nonce: Date.now() })} />
            </View>
          </Card>
        ) : null}

        <Card style={{ gap: 10 }}>
          <Text style={ui.h2}>Progress</Text>
          <ProgressBar value={progress} color={done ? palette.success : palette.ai} height={10} />
          <Text style={styles.meta}>{progress}% complete{subtasks.length ? ` · average of ${subtasks.length} parts` : ""}</Text>
          {!subtasks.length ? (
            <View style={ui.wrap}>
              {[0, 25, 50, 75, 100].map((p) => (
                <Chip key={p} small label={`${p}%`} selected={progress === p} onPress={() => void run("p", async () => {
                  await updateTask(task.id, { progress: p });
                  return p === 100 ? `"${task.title}" complete` : undefined;
                })} />
              ))}
            </View>
          ) : null}
        </Card>

        <Card style={{ gap: 10 }}>
          <View style={styles.rowBetween}>
            <Text style={ui.h2}>Subtasks</Text>
            {!task.parentTaskId ? (
              <Chip small tone="accent" label={busy === "split" ? "Thinking…" : "Split into steps"} onPress={() => void run("split", async () => {
                const r = await splitTask(task.id);
                return `Split into ${r.subtasks.length} parts`;
              })} />
            ) : null}
          </View>
          {subtasks.map((s) => (
            <View key={s.id} style={styles.subRow}>
              <Pressable
                onPress={() => void run(`s-${s.id}`, async () => {
                  await updateTask(s.id, { status: s.status === "COMPLETED" ? "PENDING" : "COMPLETED" });
                })}
                style={[styles.check, s.status === "COMPLETED" && styles.checkDone]}
              >
                <Text style={{ color: colors.bg, fontFamily: "Inter_600SemiBold", fontSize: 12 }}>{s.status === "COMPLETED" ? "✓" : ""}</Text>
              </Pressable>
              <Pressable style={{ flex: 1 }} onPress={() => navigation.push("TaskDetail", { taskId: s.id })}>
                <Text style={[ui.body, s.status === "COMPLETED" && { textDecorationLine: "line-through", color: colors.textMuted }]}>{s.title}</Text>
                <Text style={styles.meta}>{formatDue(s)}{s.durationMinutes ? ` · ${formatDuration(s.durationMinutes)}` : ""}</Text>
              </Pressable>
            </View>
          ))}
          <View style={styles.subRow}>
            <TextInput style={[ui.input, { flex: 1 }]} value={newSub} onChangeText={setNewSub} placeholder="Add a subtask" placeholderTextColor="#646A78" />
            <Chip
              label="Add"
              onPress={() => {
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

        {!done ? (
          <Card style={{ gap: 10 }}>
            <Text style={ui.h2}>Schedule</Text>
            {task.scheduledStart ? (
              <Text style={ui.body}>
                Planned {new Date(task.scheduledStart).toLocaleDateString(undefined, { weekday: "long" })} {formatTime(task.scheduledStart)}
                {task.scheduledEnd ? `–${formatTime(task.scheduledEnd)}` : ""}
              </Text>
            ) : (
              <Text style={styles.meta}>Not scheduled yet.</Text>
            )}
            {slot ? (
              <View style={{ gap: 8 }}>
                <Text style={ui.body}>{slot.reason}</Text>
                <View style={ui.wrap}>
                  <Chip small selected label="Book it" onPress={() => void run("book", async () => {
                    await updateTask(task.id, { scheduledStart: slot.start, scheduledEnd: slot.end });
                    setSlot(null);
                    return "Scheduled";
                  })} />
                  <Chip small label="Not now" onPress={() => setSlot(null)} />
                </View>
              </View>
            ) : (
              <View style={ui.wrap}>
                <Chip small tone="accent" label={busy === "slot" ? "Looking…" : "Find time for it"} onPress={() => void run("slot", async () => {
                  const s = await suggestSlot(task.id);
                  if (!s) return "No free slot found before the deadline.";
                  setSlot(s);
                })} />
                {(task.durationMinutes ?? 0) >= 90 ? (
                  <Chip small label="Break into 45-min chunks" onPress={() => void viaAssistant("chunk", { type: "chunk_task", taskId: task.id }, "Break into chunks")} />
                ) : null}
              </View>
            )}
          </Card>
        ) : null}

        <View style={{ gap: 10 }}>
          <Button
            title={done ? "Reopen task" : "Mark complete"}
            kind={done ? "secondary" : "primary"}
            loading={busy === "done"}
            onPress={() => void run("done", async () => {
              await updateTask(task.id, { status: done ? "PENDING" : "COMPLETED" });
              return done ? "Reopened" : "Marked as done";
            })}
          />
          {canUndo ? (
            <Button title="Undo last change" kind="secondary" loading={busy === "undo"} onPress={() => void run("undo", async () => {
              await undoTaskEdit(task.id);
              return "Change undone";
            })} />
          ) : null}
          <Button title="Discuss with the assistant" kind="tonal" onPress={() => navigation.navigate("Assistant", { prefill: `About "${task.title}": `, nonce: Date.now() })} />
          {done ? (
            <Button title="Archive (hide, keep history)" kind="secondary" onPress={() => void run("arch", async () => {
              await updateTask(task.id, { archived: true });
              navigation.goBack();
            })} />
          ) : null}
          <Button
            title="Delete"
            kind="danger"
            onPress={() =>
              Alert.alert(`Delete "${task.title}"?`, "You can undo within 1 day.", [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Delete",
                  style: "destructive",
                  onPress: async () => {
                    await deleteTask(task.id);
                    navigation.navigate("TaskList", { toast: `Deleted "${task.title}" — undo from Tasks within 24h` });
                  },
                },
              ])
            }
          />
        </View>
      </ScrollView>
      <Snackbar text={toast} onHide={() => setToast(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14, paddingBottom: 60 },
  edit: { color: colors.primary, fontFamily: "Inter_600SemiBold" },
  parent: { color: palette.ai, fontFamily: "Inter_600SemiBold" },
  title: { fontSize: 22, fontFamily: "Inter_700Bold", color: colors.text },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  badgeText: { fontSize: 12, fontFamily: "Inter_700Bold" },
  meta: { fontFamily: "Inter_400Regular", fontSize: 13, color: colors.textMuted },
  tags: { color: colors.primaryDark, fontFamily: "Inter_500Medium" },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  subRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  check: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: palette.success, alignItems: "center", justifyContent: "center" },
  checkDone: { backgroundColor: palette.success },
});
