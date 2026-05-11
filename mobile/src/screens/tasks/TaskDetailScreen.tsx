import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { LinearGradient } from "expo-linear-gradient";
import { useCallback, useLayoutEffect, useState } from "react";
import {
  Alert,
  LayoutAnimation,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { ScreenHeader } from "../../components/ScreenHeader";
import { colors, radii, shadow } from "../../constants/theme";
import type { MainStackParamList } from "../../navigation/MainStack";
import { clearTaskReminder, reminderFeedbackText, upsertTaskReminder } from "../../services/reminders";
import { deleteTask, getTask, updateTask } from "../../services/tasksApi";
import type { Task } from "../../types/models";
import { priorityPill } from "../../utils/priorityColors";

type Props = NativeStackScreenProps<MainStackParamList, "TaskDetail">;

function statusMetaColor(status: Task["status"]): string {
  if (status === "COMPLETED") return "#16A34A";
  if (status === "IN_PROGRESS") return "#1D99FF";
  return colors.textMuted;
}

function formatDue(task: Task): string {
  if (!task.dueDate && !task.dueTime) return "Not set";
  const parts: string[] = [];
  if (task.dueDate) {
    const d = new Date(task.dueDate);
    parts.push(d.toLocaleString(undefined, { dateStyle: "medium" }));
  }
  if (task.dueTime) parts.push(task.dueTime);
  return parts.join(" · ");
}

export function TaskDetailScreen({ navigation, route }: Props) {
  const { taskId } = route.params;
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);

  const load = useCallback(() => {
    setError(null);
    getTask(taskId)
      .then(setTask)
      .catch(() => setError("Could not load this task."));
  }, [taskId]);

  useLayoutEffect(() => {
    load();
  }, [load]);

  const confirmDelete = () => {
    Alert.alert("Delete task", "This task will be removed permanently.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          deleteTask(taskId)
            .then(async () => {
              await clearTaskReminder(taskId);
              navigation.navigate("TaskList", {
                toast: "Task deleted and reminder cleared",
                toastTone: "warning",
              });
            })
            .catch(() => Alert.alert("Delete failed", "Please try again."));
        },
      },
    ]);
  };

  if (error) {
    return (
      <View style={styles.centered}>
        <ScreenHeader title="Task" onBack={() => navigation.goBack()} />
        <View style={styles.centerBody}>
          <Text style={styles.error}>{error}</Text>
        </View>
      </View>
    );
  }

  if (!task) {
    return (
      <View style={styles.centered}>
        <ScreenHeader title="Task" onBack={() => navigation.goBack()} />
        <View style={styles.centerBody}>
          <Text style={styles.muted}>Loading task details…</Text>
        </View>
      </View>
    );
  }

  const pill = priorityPill(task.priority);

  const markCompleted = async () => {
    if (task.status === "COMPLETED") return;
    setCompleting(true);
    try {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      const updated = await updateTask(taskId, { status: "COMPLETED" });
      const reminder = await upsertTaskReminder(updated);
      setTask(updated);
      if (reminder.kind !== "scheduled") {
        Alert.alert("Reminder", reminderFeedbackText(reminder));
      }
    } catch {
      Alert.alert("Update failed", "Could not mark this task complete.");
    } finally {
      setCompleting(false);
    }
  };

  const metaRows: { label: string; value: string; valueColor?: string }[] = [
    {
      label: "Status",
      value: task.status.replace("_", " "),
      valueColor: statusMetaColor(task.status),
    },
    { label: "Due", value: formatDue(task), valueColor: colors.textMuted },
    ...(task.category
      ? [{ label: "Category", value: task.category, valueColor: colors.textMuted }]
      : []),
    {
      label: "Source",
      value: task.source.replace("_", " "),
      valueColor: colors.textMuted,
    },
  ];

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="Task"
        onBack={() => navigation.goBack()}
        right={
          <Pressable onPress={() => navigation.navigate("EditTask", { taskId })} hitSlop={8}>
            <Text style={styles.edit}>Edit</Text>
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{task.title}</Text>
          <View style={[styles.priorityPill, { backgroundColor: pill.backgroundColor }]}>
            <Text style={[styles.priorityText, { color: pill.color }]}>{task.priority}</Text>
          </View>
        </View>

        <View style={styles.metaList}>
          {metaRows.map((row) => (
            <View key={row.label} style={styles.metaCard}>
              <Text style={styles.metaLabel}>{row.label}</Text>
              <Text style={[styles.metaValue, row.valueColor ? { color: row.valueColor } : null]}>
                {row.value}
              </Text>
            </View>
          ))}
        </View>

        {task.description ? (
          <View style={styles.descCard}>
            <Text style={styles.descHeading}>Description</Text>
            <Text style={styles.descBody}>{task.description}</Text>
          </View>
        ) : null}

        <Pressable
          style={({ pressed }) => [styles.completeWrap, pressed && styles.btnPressed]}
          onPress={() => void markCompleted()}
          disabled={task.status === "COMPLETED" || completing}
        >
          <LinearGradient
            colors={task.status === "COMPLETED" ? ["#22C55E", "#16A34A"] : ["#16A34A", "#15803D"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={styles.completeGrad}
          >
            <Text style={styles.completeText}>
              {task.status === "COMPLETED"
                ? "Completed ✓"
                : completing
                  ? "Completing…"
                  : "Mark as complete"}
            </Text>
          </LinearGradient>
        </Pressable>

        <View style={styles.divider} />

        <Pressable style={({ pressed }) => [styles.delete, pressed && styles.btnPressed]} onPress={confirmDelete}>
          <Text style={styles.deleteText}>Delete task</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  centered: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  centerBody: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  container: {
    padding: 24,
    paddingBottom: 40,
    gap: 24,
  },
  edit: {
    fontSize: 14,
    fontWeight: "600",
    color: "#0065C3",
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  title: {
    flex: 1,
    fontSize: 24,
    fontWeight: "600",
    color: colors.text,
    lineHeight: 30,
  },
  priorityPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radii.pill,
    alignSelf: "flex-start",
  },
  priorityText: {
    fontSize: 12,
    fontWeight: "700",
  },
  metaList: {
    gap: 12,
  },
  metaCard: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow,
  },
  metaLabel: {
    fontWeight: "500",
    color: colors.textMuted,
    fontSize: 15,
  },
  metaValue: {
    fontWeight: "600",
    fontSize: 15,
    color: colors.text,
    textAlign: "right",
    flexShrink: 1,
    marginLeft: 12,
  },
  descCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow,
  },
  descHeading: {
    fontWeight: "600",
    fontSize: 16,
    color: colors.text,
    marginBottom: 8,
  },
  descBody: {
    color: colors.textMuted,
    fontSize: 15,
    lineHeight: 22,
  },
  completeWrap: {
    borderRadius: radii.md,
    overflow: "hidden",
    ...shadow,
  },
  completeGrad: {
    height: 56,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  completeText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 16,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: 8,
  },
  delete: {
    height: 56,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#FECACA",
    backgroundColor: "#FEF2F2",
  },
  deleteText: {
    color: "#DC2626",
    fontWeight: "600",
    fontSize: 16,
  },
  btnPressed: {
    opacity: 0.92,
    transform: [{ scale: 0.97 }],
  },
  error: {
    color: "#b91c1c",
    textAlign: "center",
  },
  muted: {
    color: colors.textMuted,
    textAlign: "center",
  },
});
