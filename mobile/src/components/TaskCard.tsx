import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, palette, radii, shadowTile } from "../constants/theme";
import type { Task } from "../types/models";
import { formatDue, isOverdue } from "../utils/format";
import { categoryColor, priorityColor, priorityPill } from "../utils/priorityColors";
import { HighlightText, ProgressBar } from "./ui";

type Props = {
  task: Task;
  onPress?: () => void;
  onLongPress?: () => void;
  variant?: "dashboard" | "list" | "compact";
  query?: string;
  subtaskCount?: number;
  expanded?: boolean;
  onToggleExpand?: () => void;
  categoryColors?: Array<{ name: string; color: string }>;
};

function statusLabel(task: Task): string {
  if (isOverdue(task)) return "OVERDUE";
  return task.status.replace("_", " ");
}

export function TaskCard({ task, onPress, onLongPress, variant = "list", query = "", subtaskCount, expanded, onToggleExpand, categoryColors }: Props) {
  const done = task.status === "COMPLETED";
  const overdue = isOverdue(task);
  const pill = priorityPill(task.priority);
  const progress = task.progress ?? 0;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [styles.card, done && styles.cardDone, overdue && styles.cardOverdue, pressed && styles.cardPressed]}
    >
      <View style={[styles.bar, { backgroundColor: done ? "#86EFAC" : priorityColor(task.priority) }]} />
      <View style={styles.body}>
        <View style={styles.row}>
          {done ? <Text style={styles.check}>✓</Text> : null}
          <HighlightText text={task.title} query={query} style={[styles.title, done && styles.titleDone]} numberOfLines={2} />
          <View style={[styles.badge, { backgroundColor: pill.backgroundColor }]}>
            <Text style={[styles.badgeText, { color: pill.color }]}>{task.priority}</Text>
          </View>
        </View>
        <View style={styles.metaRow}>
          <Text style={[styles.meta, overdue && { color: palette.danger, fontWeight: "700" }]}>{formatDue(task)}</Text>
          {variant !== "compact" ? (
            <>
              <Text style={styles.dot}>•</Text>
              <Text style={[styles.meta, done && { color: palette.success, fontWeight: "600" }, overdue && { color: palette.danger }]}>{statusLabel(task)}</Text>
            </>
          ) : null}
          {task.category ? (
            <View style={[styles.cat, { borderColor: categoryColor(task.category, categoryColors) }]}>
              <Text style={[styles.catText, { color: categoryColor(task.category, categoryColors) }]}>{task.category}</Text>
            </View>
          ) : null}
          {task.pendingSync ? <Text style={styles.pending}>⟳ pending sync</Text> : null}
        </View>
        {variant === "list" && Array.isArray(task.tags) && task.tags.length ? (
          <View style={styles.tags}>
            {task.tags.slice(0, 4).map((t) => (
              <Text key={t} style={styles.tag}>
                #{t}
              </Text>
            ))}
          </View>
        ) : null}
        {progress > 0 && !done ? (
          <View style={{ marginTop: 8, gap: 2 }}>
            <ProgressBar value={progress} color={palette.ai} height={5} />
            <Text style={styles.meta}>{progress}% done</Text>
          </View>
        ) : null}
        {subtaskCount ? (
          <Pressable onPress={onToggleExpand} hitSlop={8} style={{ marginTop: 6 }}>
            <Text style={styles.subtasks}>
              {expanded ? "▾" : "▸"} {subtaskCount} subtask{subtaskCount === 1 ? "" : "s"}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
    ...shadowTile,
  },
  bar: { width: 5 },
  body: { flex: 1, padding: 12 },
  cardDone: { backgroundColor: "#F8FAFC", opacity: 0.75 },
  cardOverdue: { borderColor: "#FECACA", backgroundColor: "#FFFBFB" },
  cardPressed: { transform: [{ scale: 0.985 }] },
  row: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  check: { color: palette.success, fontWeight: "900", fontSize: 16 },
  title: { flex: 1, fontSize: 16, fontWeight: "600", color: colors.text, lineHeight: 21 },
  titleDone: { textDecorationLine: "line-through", color: colors.textMuted },
  badge: { borderRadius: radii.pill, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { fontSize: 10, fontWeight: "700" },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" },
  meta: { color: colors.textMuted, fontSize: 13 },
  dot: { color: colors.textMuted, fontSize: 12 },
  cat: { borderWidth: 1, borderRadius: radii.pill, paddingHorizontal: 7, paddingVertical: 1 },
  catText: { fontSize: 11, fontWeight: "700" },
  pending: { fontSize: 11, color: palette.muted, fontStyle: "italic" },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  tag: { fontSize: 12, color: colors.primaryDark, backgroundColor: colors.surfaceSoft, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  subtasks: { fontSize: 13, color: palette.ai, fontWeight: "700" },
});
