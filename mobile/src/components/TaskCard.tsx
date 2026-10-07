import { Pressable, StyleSheet, View } from "react-native";
import { useTheme } from "../theme/ThemeProvider";
import type { Task } from "../types/models";
import { formatDue, isOverdue } from "../utils/format";
import { priorityColor } from "../utils/priorityColors";
import { Icon } from "./icons/Icon";
import { Dot, HighlightText, ProgressBar, Text } from "./ui";

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

const label = (p: string) => p.charAt(0) + p.slice(1).toLowerCase();

export function TaskCard({ task, onPress, onLongPress, variant = "list", query = "", subtaskCount, expanded, onToggleExpand }: Props) {
  const { colors, spacing, radii, elevation } = useTheme();
  const done = task.status === "COMPLETED";
  const overdue = isOverdue(task);
  const progress = task.progress ?? 0;
  const meta = [formatDue(task), variant !== "compact" && !overdue && !done ? label(task.status.replace("_", " ")) : null, task.category].filter(Boolean);

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      accessibilityRole="button"
      accessibilityLabel={`${task.title}, ${label(task.priority)} priority${overdue ? ", overdue" : ""}${done ? ", completed" : ""}`}
      style={({ pressed }) => [
        styles.card,
        variant === "compact" ? { paddingVertical: spacing.md } : elevation(1),
        { borderRadius: radii.md, padding: variant === "compact" ? 0 : spacing.lg, marginBottom: variant === "compact" ? 0 : spacing.sm },
        pressed && { opacity: 0.7 },
      ]}
    >
      <View style={styles.row}>
        <View style={styles.lead}>
          {done ? (
            <View style={[styles.doneMark, { backgroundColor: colors.text }]}>
              <Icon name="check" size={11} color={colors.canvas} strokeWidth={2.4} />
            </View>
          ) : (
            <Dot color={priorityColor(task.priority, colors)} />
          )}
        </View>
        <View style={styles.flex}>
          <HighlightText
            text={task.title}
            query={query}
            numberOfLines={2}
            style={[styles.title, { color: done ? colors.textTertiary : colors.text }, done && styles.struck]}
          />
          <Text variant="caption" color={overdue ? "danger" : "secondary"} numberOfLines={1} style={{ marginTop: 2 }}>
            {overdue ? "Overdue · " : ""}
            {meta.join(" · ")}
            {task.pendingSync ? " · Not synced" : ""}
          </Text>
          {variant === "list" && Array.isArray(task.tags) && task.tags.length ? (
            <Text variant="caption" color="tertiary" numberOfLines={1} style={{ marginTop: 2 }}>
              {task.tags.slice(0, 4).map((t) => `#${t}`).join("  ")}
            </Text>
          ) : null}
          {progress > 0 && !done ? (
            <View style={{ marginTop: spacing.sm, gap: 4 }}>
              <ProgressBar value={progress} height={3} color={colors.text} />
              <Text variant="caption" color="tertiary" tabular>
                {progress}% done
              </Text>
            </View>
          ) : null}
          {subtaskCount ? (
            <Pressable onPress={onToggleExpand} hitSlop={8} style={{ marginTop: spacing.sm }} accessibilityRole="button">
              <Text variant="label" color="accent">
                {expanded ? "Hide" : "Show"} {subtaskCount} subtask{subtaskCount === 1 ? "" : "s"}
              </Text>
            </Pressable>
          ) : null}
        </View>
        {variant !== "compact" ? (
          <Text variant="caption" color="tertiary">
            {label(task.priority)}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {},
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  lead: { width: 16, height: 22, justifyContent: "center", alignItems: "flex-start" },
  doneMark: { width: 16, height: 16, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  flex: { flex: 1 },
  title: { fontFamily: "Inter_500Medium", fontSize: 15, lineHeight: 21 },
  struck: { textDecorationLine: "line-through" },
});
