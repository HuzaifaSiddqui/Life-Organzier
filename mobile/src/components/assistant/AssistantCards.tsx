import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, palette, radii } from "../../constants/theme";
import type { ActionPayload, AssistantCard, DayPlan, Task } from "../../types/models";
import { formatDue, formatDuration, formatTime } from "../../utils/format";
import { priorityColor } from "../../utils/priorityColors";
import { ProgressBar } from "../ui";
import { BreathingExercise } from "./BreathingExercise";

type Handlers = {
  onOpenTask: (taskId: string) => void;
  onAction: (payload: ActionPayload, label: string) => void;
};

function MiniTask({ task, onPress }: { task: Task; onPress: () => void }) {
  const done = task.status === "COMPLETED";
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.mini, pressed && { opacity: 0.8 }]}>
      <View style={[styles.miniDot, { backgroundColor: done ? palette.muted : priorityColor(task.priority) }]} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.miniTitle, done && { textDecorationLine: "line-through", color: colors.textMuted }]} numberOfLines={2}>
          {task.title}
        </Text>
        <Text style={[styles.miniMeta, task.isOverdue && { color: palette.danger }]}>
          {formatDue(task)}
          {task.durationMinutes ? ` · ${formatDuration(task.durationMinutes)}` : ""}
          {task.category ? ` · ${task.category}` : ""}
        </Text>
        {task.progress && task.progress > 0 && !done ? (
          <View style={{ marginTop: 4 }}>
            <ProgressBar value={task.progress} color={colors.text} height={3} />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

function PlanTimeline({ plan }: { plan: DayPlan }) {
  if (!plan.blocks.length) return <Text style={styles.meta}>Nothing scheduled yet — your day is open.</Text>;
  const pct = Math.min(100, Math.round((plan.load.minutes / Math.max(1, plan.load.capacity)) * 100));
  return (
    <View style={{ gap: 6 }}>
      <View style={{ gap: 3 }}>
        <Text style={styles.meta}>
          Workload {formatDuration(plan.load.minutes) || "0 min"} of {formatDuration(plan.load.capacity)}
        </Text>
        <ProgressBar value={pct} color={plan.load.overloaded ? palette.danger : pct > 80 ? palette.warning : palette.success} height={5} />
      </View>
      {plan.blocks.map((b) => (
        <View key={`${b.kind}-${b.id}-${b.start}`} style={styles.block}>
          <Text style={styles.blockTime}>{formatTime(b.start)}</Text>
          <View
            style={[
              styles.blockBody,
              b.kind === "routine" && { borderLeftColor: palette.success },
              b.kind === "suggested" && { borderLeftColor: colors.primary, borderStyle: "dashed" },
              b.kind === "due" && { borderLeftColor: palette.danger },
            ]}
          >
            <Text style={styles.blockTitle} numberOfLines={1}>
              {b.kind === "due" ? "Due: " : ""}
              {b.title}
            </Text>
            <Text style={styles.meta}>
              {b.kind === "due" ? "deadline" : `${formatTime(b.start)}–${formatTime(b.end)}`}
              {b.kind === "suggested" ? " · suggested" : b.kind === "routine" ? (b.mandatory ? " · mandatory routine" : " · routine") : ""}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

export function AssistantCards({ cards, onOpenTask, onAction }: { cards: AssistantCard[] } & Handlers) {
  return (
    <View style={{ gap: 8 }}>
      {cards.map((card, i) => {
        switch (card.type) {
          case "task":
            return <MiniTask key={i} task={card.task} onPress={() => onOpenTask(card.task.id)} />;
          case "progress":
            return (
              <View key={i} style={styles.panel}>
                <Text style={styles.panelTitle}>{card.task.title}</Text>
                <ProgressBar value={card.task.progress ?? 0} color={palette.ai} height={8} />
                <Text style={styles.meta}>{card.task.progress ?? 0}% complete</Text>
              </View>
            );
          case "task_list":
            return (
              <View key={i} style={styles.panel}>
                <Text style={styles.panelTitle}>{card.title}</Text>
                {card.tasks.length ? (
                  card.tasks.map((t) => <MiniTask key={t.id} task={t} onPress={() => onOpenTask(t.id)} />)
                ) : (
                  <Text style={styles.meta}>{card.emptyText ?? "Nothing here"}</Text>
                )}
              </View>
            );
          case "draft": {
            const d = card.draft;
            const color = card.clarity >= 95 ? palette.success : card.clarity >= 50 ? palette.warning : palette.danger;
            return (
              <View key={i} style={styles.panel}>
                <View style={styles.rowBetween}>
                  <Text style={styles.panelTitle}>What I understood</Text>
                  <Text style={[styles.clarity, { color }]}>Clarity {card.clarity}%</Text>
                </View>
                <ProgressBar value={card.clarity} color={color} height={4} />
                <Field label="Task" value={d.title} missing={card.missing.includes("title")} />
                <Field label="When" value={d.dueYmd ? `${d.dueYmd}${d.dueTime ? ` · ${d.dueTime}` : ""}` : d.dueTime} missing={card.missing.includes("date") || card.missing.includes("time")} />
                <Field label="Duration" value={d.durationMinutes ? formatDuration(d.durationMinutes) : null} missing={card.missing.includes("duration")} />
                <Field label="Priority" value={d.priority} />
                <Field label="Type" value={d.taskType.toLowerCase()} />
                {d.category ? <Field label="Category" value={d.category} /> : null}
                {d.tags?.length ? <Field label="Tags" value={d.tags.map((t) => `#${t}`).join(" ")} /> : null}
              </View>
            );
          }
          case "routine":
            return (
              <View key={i} style={styles.panel}>
                <Text style={styles.panelTitle}>
                  {card.routine.title}
                </Text>
                <Text style={styles.meta}>
                  {card.routine.priority === "MANDATORY" ? "Mandatory · " : ""}
                  {card.routine.frequency.charAt(0) + card.routine.frequency.slice(1).toLowerCase()}
                  {card.routine.dueTime ? ` · ${card.routine.dueTime}` : " · flexible time"}
                  {card.routine.durationMinutes ? ` · ${formatDuration(card.routine.durationMinutes)}` : ""}
                  {card.routine.timeLocked ? " · time-locked" : ""}
                </Text>
              </View>
            );
          case "mood_support": {
            const r = card.recommendation;
            return (
              <View key={i} style={styles.panel}>
                {r.primary ? (
                  <Pressable style={styles.primarySuggestion} onPress={() => onAction(r.primary!.action, r.primary!.label)}>
                    <Text style={styles.primaryText}>{r.primary.label}</Text>
                    <Text style={styles.primaryGo}>Start</Text>
                  </Pressable>
                ) : null}
                {r.suggestions.length ? <Text style={styles.meta}>After that, you could:</Text> : null}
                {r.suggestions.map((s) => (
                  <Pressable key={s.id} style={styles.suggestion} onPress={() => onAction(s.action, s.label)}>
                    <Text style={styles.suggestionText}>{s.label}</Text>
                    {s.detail ? <Text style={styles.meta}>{s.detail}</Text> : null}
                  </Pressable>
                ))}
                {r.avoid.length ? <Text style={styles.meta}>Skipping for now: {r.avoid.join(", ")}</Text> : null}
              </View>
            );
          }
          case "suggestions":
            return (
              <View key={i} style={styles.panel}>
                <Text style={styles.panelTitle}>{card.title}</Text>
                {card.items.map((s) => (
                  <Pressable key={s.id} style={styles.suggestion} onPress={() => onAction(s.action, s.label)}>
                    <Text style={styles.suggestionText}>{s.label}</Text>
                  </Pressable>
                ))}
              </View>
            );
          case "plan":
            return (
              <View key={i} style={styles.panel}>
                <Text style={styles.panelTitle}>Plan for {card.plan.label}</Text>
                <PlanTimeline plan={card.plan} />
              </View>
            );
          case "breathing":
            return (
              <View key={i} style={styles.panel}>
                <BreathingExercise minutes={card.minutes} />
              </View>
            );
          case "insight":
            return (
              <View key={i} style={styles.panel}>
                <Text style={styles.suggestionText}>{card.text}</Text>
                <Text style={styles.meta}>Confidence {Math.round(card.confidence * 100)}%</Text>
              </View>
            );
          case "resources":
            return (
              <View key={i} style={[styles.panel, { backgroundColor: palette.dangerSoft, borderColor: "transparent" }]}>
                <Text style={styles.panelTitle}>You're not alone</Text>
                <Pressable onPress={() => void Linking.openURL("tel:1122")}>
                  <Text style={[styles.suggestionText, { color: palette.danger }]}>Call emergency services · 1122</Text>
                </Pressable>
                <Pressable onPress={() => void Linking.openURL("tel:115")}>
                  <Text style={[styles.suggestionText, { color: palette.danger }]}>Edhi helpline · 115</Text>
                </Pressable>
                <Text style={styles.meta}>Please also reach out to someone you trust or a licensed professional.</Text>
              </View>
            );
          default:
            return null;
        }
      })}
    </View>
  );
}

function Field({ label, value, missing }: { label: string; value: string | null | undefined; missing?: boolean }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={[styles.fieldValue, missing && { color: palette.warning, fontStyle: "italic" }]}>{value ?? (missing ? "needed" : "—")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  mini: {
    flexDirection: "row",
    gap: 10,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
  },
  miniDot: { width: 8, height: 8, borderRadius: 4, marginTop: 7 },
  miniTitle: { fontSize: 15, fontFamily: "Inter_500Medium", color: colors.text },
  miniMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: colors.textMuted, marginTop: 2 },
  panel: { backgroundColor: colors.surface, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, padding: 14, gap: 8 },
  panelTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: colors.text },
  meta: { fontSize: 12, fontFamily: "Inter_400Regular", color: colors.textMuted },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  clarity: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  field: { flexDirection: "row", gap: 8 },
  fieldLabel: { width: 70, fontSize: 12, fontFamily: "Inter_400Regular", color: colors.textMuted },
  fieldValue: { flex: 1, fontSize: 13, fontFamily: "Inter_500Medium", color: colors.text },
  primarySuggestion: {
    backgroundColor: colors.text,
    borderRadius: 12,
    padding: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  primaryText: { color: colors.bg, fontFamily: "Inter_500Medium", flex: 1 },
  primaryGo: { color: colors.bg, fontFamily: "Inter_600SemiBold" },
  suggestion: { paddingVertical: 4 },
  suggestionText: { fontSize: 14, color: colors.text, fontFamily: "Inter_500Medium" },
  block: { flexDirection: "row", gap: 8, alignItems: "stretch" },
  blockTime: { width: 62, fontSize: 12, fontFamily: "Inter_400Regular", color: colors.textMuted, paddingTop: 2 },
  blockBody: { flex: 1, borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: 10, paddingVertical: 2 },
  blockTitle: { fontSize: 13, fontFamily: "Inter_500Medium", color: colors.text },
});
