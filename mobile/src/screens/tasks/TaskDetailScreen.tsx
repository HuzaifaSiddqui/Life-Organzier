import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useLayoutEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { MainStackParamList } from "../../navigation/MainStack";
import { deleteTask, getTask } from "../../services/tasksApi";
import type { Task } from "../../types/models";
import { priorityColor } from "../../utils/priorityColors";

type Props = NativeStackScreenProps<MainStackParamList, "TaskDetail">;

export function TaskDetailScreen({ navigation, route }: Props) {
  const { taskId } = route.params;
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    getTask(taskId)
      .then(setTask)
      .catch(() => setError("Could not load this task."));
  }, [taskId]);

  useLayoutEffect(() => {
    load();
  }, [load]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable onPress={() => navigation.navigate("EditTask", { taskId })}>
          <Text style={styles.headerAction}>Edit</Text>
        </Pressable>
      ),
    });
  }, [navigation, taskId]);

  const confirmDelete = () => {
    Alert.alert("Delete task", "This task will be removed permanently.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          deleteTask(taskId)
            .then(() => navigation.popToTop())
            .catch(() => Alert.alert("Delete failed", "Please try again."));
        },
      },
    ]);
  };

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  if (!task) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>Loading…</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>{task.title}</Text>
      <View style={[styles.badge, { backgroundColor: priorityColor(task.priority) }]}>
        <Text style={styles.badgeText}>{task.priority}</Text>
      </View>
      <View style={styles.block}>
        <Text style={styles.label}>Status</Text>
        <Text style={styles.value}>{task.status.replace("_", " ")}</Text>
      </View>
      <View style={styles.block}>
        <Text style={styles.label}>Source</Text>
        <Text style={styles.value}>{task.source}</Text>
      </View>
      {task.category ? (
        <View style={styles.block}>
          <Text style={styles.label}>Category</Text>
          <Text style={styles.value}>{task.category}</Text>
        </View>
      ) : null}
      <View style={styles.block}>
        <Text style={styles.label}>Due</Text>
        <Text style={styles.value}>
          {task.dueDate
            ? `${new Date(task.dueDate).toLocaleDateString()}${task.dueTime ? ` · ${task.dueTime}` : ""}`
            : "Not set"}
        </Text>
      </View>
      {task.description ? (
        <View style={styles.block}>
          <Text style={styles.label}>Description</Text>
          <Text style={styles.value}>{task.description}</Text>
        </View>
      ) : null}
      {task.confidence != null ? (
        <View style={styles.block}>
          <Text style={styles.label}>Parser confidence</Text>
          <Text style={styles.value}>{task.confidence}%</Text>
        </View>
      ) : null}

      <Pressable style={styles.delete} onPress={confirmDelete}>
        <Text style={styles.deleteText}>Delete task</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f7f8fb",
  },
  container: {
    padding: 20,
    backgroundColor: "#f7f8fb",
    gap: 12,
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: "#0f172a",
  },
  badge: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  badgeText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 12,
  },
  block: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  label: {
    fontSize: 12,
    color: "#64748b",
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  value: {
    fontSize: 16,
    color: "#0f172a",
  },
  delete: {
    marginTop: 16,
    borderWidth: 1,
    borderColor: "#fecaca",
    backgroundColor: "#fef2f2",
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
  },
  deleteText: {
    color: "#b91c1c",
    fontWeight: "600",
  },
  error: {
    color: "#b91c1c",
  },
  muted: {
    color: "#64748b",
  },
  headerAction: {
    color: "#2563eb",
    fontWeight: "600",
    marginRight: 8,
  },
});
