import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radii, shadow, shadowTile } from "../constants/theme";
import type { Task } from "../types/models";
import { priorityPill } from "../utils/priorityColors";
import { ClockIcon } from "./icons/ClockIcon";

type Props = {
  task: Task;
  onPress: () => void;
  /** Dashboard list matches prototype (clock + priority pill); task list adds status row */
  variant?: "dashboard" | "list";
};

function formatDue(task: Task): string {
  const parts: string[] = [];
  if (task.dueDate) {
    const d = new Date(task.dueDate);
    parts.push(d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }));
  }
  if (task.dueTime) {
    parts.push(task.dueTime);
  }
  return parts.length ? parts.join(", ") : "No due date";
}

function statusLabel(status: Task["status"]): string {
  return status.replace("_", " ");
}

export function TaskCard({ task, onPress, variant = "list" }: Props) {
  const done = task.status === "COMPLETED";
  const pill = priorityPill(task.priority);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        done && styles.cardDone,
        variant === "dashboard" && styles.cardDashboard,
        pressed && styles.cardPressed,
      ]}
    >
      <View style={styles.row}>
        <Text style={[styles.title, done && styles.titleDone]} numberOfLines={2}>
          {task.title}
        </Text>
        <View style={[styles.badge, { backgroundColor: pill.backgroundColor }]}>
          <Text style={[styles.badgeText, { color: pill.color }]}>{task.priority}</Text>
        </View>
      </View>
      {variant === "dashboard" ? (
        <View style={styles.timeRow}>
          <ClockIcon size={14} color={colors.textMuted} />
          <Text style={styles.meta}>{formatDue(task)}</Text>
        </View>
      ) : (
        <View style={styles.listMetaRow}>
          <Text style={[styles.statusText, done && styles.statusDone]}>{statusLabel(task.status)}</Text>
          <Text style={styles.dot}>•</Text>
          <Text style={styles.meta}>{formatDue(task)}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadowTile,
  },
  cardDashboard: {
    ...shadow,
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  cardDone: {
    borderColor: "#BBF7D0",
    backgroundColor: "#F0FDF4",
  },
  cardPressed: {
    transform: [{ scale: 0.98 }],
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
    alignItems: "flex-start",
    marginBottom: 8,
  },
  title: {
    flex: 1,
    fontSize: 17,
    fontWeight: "600",
    color: colors.text,
    lineHeight: 22,
  },
  titleDone: {
    textDecorationLine: "line-through",
    color: colors.textMuted,
  },
  badge: {
    borderRadius: radii.pill,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignSelf: "flex-start",
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "600",
  },
  timeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  listMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  statusText: {
    fontSize: 14,
    color: colors.textMuted,
  },
  statusDone: {
    color: "#16A34A",
    fontWeight: "600",
  },
  dot: {
    fontSize: 14,
    color: colors.textMuted,
  },
  meta: {
    color: colors.textMuted,
    fontSize: 14,
  },
});
