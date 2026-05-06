import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Task } from "../types/models";
import { priorityColor } from "../utils/priorityColors";

type Props = {
  task: Task;
  onPress: () => void;
};

function formatDue(task: Task): string {
  const parts: string[] = [];
  if (task.dueDate) {
    const d = new Date(task.dueDate);
    parts.push(d.toLocaleDateString());
  }
  if (task.dueTime) {
    parts.push(task.dueTime);
  }
  return parts.length ? parts.join(" · ") : "No due date";
}

export function TaskCard({ task, onPress }: Props) {
  return (
    <Pressable onPress={onPress} style={styles.card}>
      <View style={styles.row}>
        <Text style={styles.title} numberOfLines={2}>
          {task.title}
        </Text>
        <View style={[styles.badge, { backgroundColor: priorityColor(task.priority) }]}>
          <Text style={styles.badgeText}>{task.priority}</Text>
        </View>
      </View>
      <Text style={styles.meta}>{formatDue(task)}</Text>
      <View style={styles.tags}>
        {task.category ? (
          <Text style={styles.tag}>{task.category}</Text>
        ) : null}
        <Text style={styles.tag}>{task.status.replace("_", " ")}</Text>
        <Text style={styles.tag}>{task.source}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
    alignItems: "flex-start",
  },
  title: {
    flex: 1,
    fontSize: 16,
    fontWeight: "600",
    color: "#0f172a",
  },
  badge: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  badgeText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "700",
  },
  meta: {
    marginTop: 6,
    color: "#64748b",
    fontSize: 13,
  },
  tags: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 8,
  },
  tag: {
    fontSize: 12,
    color: "#475569",
    backgroundColor: "#f1f5f9",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: "hidden",
  },
});
