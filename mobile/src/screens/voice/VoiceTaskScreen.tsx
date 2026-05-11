import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { LinearGradient } from "expo-linear-gradient";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { InlineTimePickerField } from "../../components/DueDateTimePickers";
import { ListeningWaveform } from "../../components/ListeningWaveform";
import { ScreenHeader } from "../../components/ScreenHeader";
import { GradientPrimaryButton } from "../../components/GradientPrimaryButton";
import { colors, radii, shadow } from "../../constants/theme";
import { useDeviceSpeechRecognition } from "../../hooks/useDeviceSpeechRecognition";
import type { MainStackParamList } from "../../navigation/MainStack";
import { createTaskWithReminder } from "../../services/createTaskWithReminder";
import { reminderFeedbackText } from "../../services/reminders";
import { parseTaskText } from "../../services/tasksApi";
import type { ParsedTask, Priority } from "../../types/models";
import { dueDateAndTimeForSave, validateDueDateNotPast, ymdFromLocalDate } from "../../utils/datetimeValidation";
import { priorityPill } from "../../utils/priorityColors";

type Props = NativeStackScreenProps<MainStackParamList, "VoiceTask">;

const intro =
  "Tap the microphone to speak your task. Your device converts speech to text (no cloud). Then we extract title, due date, time, and priority — same parser as chat.";

export function VoiceTaskScreen({ navigation }: Props) {
  const [transcript, setTranscript] = useState("");
  const [parsed, setParsed] = useState<ParsedTask | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualTime, setManualTime] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [selectedPriority, setSelectedPriority] = useState<Priority | null>(null);

  const runParse = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t) {
      setParsed(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await parseTaskText(t);
      setParsed(result);
      setSelectedPriority(null);
      setManualTime("");
      setAllDay(false);
    } catch {
      setError("Could not parse that text. Try editing it or speak more clearly.");
      setParsed(null);
    } finally {
      setBusy(false);
    }
  }, []);

  const { start, stop, listening, speechSupported } = useDeviceSpeechRecognition({
    onTranscriptChange: setTranscript,
    onError: (m) => setError(m),
  });

  const startListening = () => {
    setError(null);
    void start(transcript);
  };

  const canSave = (() => {
    if (!parsed || !parsed.title.trim()) return false;
    if (!parsed.priorityDetected && !selectedPriority) return false;
    if (!parsed.timeDetected && !manualTime.trim() && !allDay) return false;
    if ((parsed.dueDateYmd?.trim() || parsed.dueDateIso) && !parsed.dueTime) {
      return allDay || manualTime.trim().length > 0;
    }
    return true;
  })();

  const save = async () => {
    if (!parsed || !canSave) return;
    setSaving(true);
    setError(null);
    try {
      const priorityOut = selectedPriority ?? (parsed.priority as Priority);
      let dueTimeOut: string | null;
      if ((parsed.dueDateYmd?.trim() || parsed.dueDateIso) && !parsed.dueTime) {
        if (allDay) dueTimeOut = null;
        else dueTimeOut = manualTime.trim() ? manualTime.trim() : null;
      } else {
        const merged = `${manualTime.trim() || (parsed.dueTime ?? "")}`.trim();
        dueTimeOut = merged === "" ? null : merged;
      }
      const pickerYmd = parsed.dueDateYmd?.trim();
      const { dueDateIso: dueDateOut, dueTime: dueTimeNormalized } = dueDateAndTimeForSave({
        pickerYmd: pickerYmd || undefined,
        parsedDueDateIso: pickerYmd ? null : parsed.dueDateIso,
        rawDueTime: dueTimeOut,
      });
      if (dueTimeNormalized && !dueDateOut) {
        setError(
          "Couldn't read that due time for reminders. Use the time picker or a clear time like 3 PM.",
        );
        return;
      }
      const dateErr = validateDueDateNotPast(dueDateOut, dueTimeNormalized);
      if (dateErr) {
        setError(dateErr);
        return;
      }
      const { reminder } = await createTaskWithReminder(
        {
          title: parsed.title.trim(),
          description: transcript.trim() ? transcript.trim() : null,
          dueDate: dueDateOut,
          dueTime: dueTimeNormalized,
          priority: priorityOut,
          category: parsed.category,
          source: "VOICE",
          confidence: parsed.confidence,
        },
        {
          reminderEnabled: true,
          reminderHint: { dueDateIso: dueDateOut, dueTime: dueTimeNormalized },
        },
      );
      setTranscript("");
      setParsed(null);
      navigation.navigate("TaskList", {
        toast: reminderFeedbackText(reminder),
        toastTone: reminder.kind === "scheduled" ? "success" : "warning",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save task.");
    } finally {
      setSaving(false);
    }
  };

  const previewPill = parsed ? priorityPill(parsed.priority as Priority) : null;
  const confidenceStyle =
    parsed && parsed.needsConfirmation
      ? { backgroundColor: "#FFFBEB", color: "#B45309" }
      : { backgroundColor: "#F0FDF4", color: "#16A34A" };

  const dueDisplay =
    parsed?.dueSummary ??
    (parsed && (parsed.dueDateText || parsed.dueTime)
      ? [parsed.dueDateText, parsed.dueTime].filter(Boolean).join(" · ")
      : null);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 12}
    >
      <ScreenHeader title="Voice task" onBack={() => navigation.goBack()} />

      <ScrollView
        style={styles.thread}
        contentContainerStyle={styles.threadContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.rowStart}>
          <View style={styles.bubbleAssistant}>
            <Text style={styles.bubbleAssistantText}>{intro}</Text>
            {!speechSupported ? (
              <Text style={styles.expoGoHint}>
                Voice requires a development build (not Expo Go). Use{" "}
                <Text style={styles.expoGoHintEm}>npx expo run:ios</Text> or{" "}
                <Text style={styles.expoGoHintEm}>npx expo run:android</Text>.
              </Text>
            ) : null}
          </View>
        </View>

        {transcript.trim() ? (
          <View style={styles.rowEnd}>
            <LinearGradient
              colors={["#1D99FF", "#47AFFF"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 0, y: 1 }}
              style={styles.bubbleUser}
            >
              <Text style={styles.bubbleUserText}>{transcript.trim()}</Text>
            </LinearGradient>
          </View>
        ) : null}

        {busy ? (
          <View style={styles.rowStart}>
            <View style={[styles.bubbleAssistant, styles.thinking]}>
              <ActivityIndicator color={colors.primary} />
            </View>
          </View>
        ) : null}

        {parsed ? (
          <View style={styles.rowStart}>
            <View style={styles.bubbleAssistantWide}>
              <Text style={styles.bubbleAssistantText}>Got it! Here’s what I understood:</Text>

              <View style={styles.previewCard}>
                <View style={styles.previewRow}>
                  <Text style={styles.previewLabel}>Title</Text>
                  <Text style={styles.previewValueStrong} numberOfLines={3}>
                    {parsed.title}
                  </Text>
                </View>
                <View style={styles.previewRow}>
                  <Text style={styles.previewLabel}>Due</Text>
                  <Text style={styles.previewValue}>{dueDisplay ?? "Not detected"}</Text>
                </View>
                <View style={styles.previewRow}>
                  <Text style={styles.previewLabel}>Priority</Text>
                  {previewPill ? (
                    <View
                      style={[styles.miniPill, { backgroundColor: previewPill.backgroundColor }]}
                    >
                      <Text style={[styles.miniPillText, { color: previewPill.color }]}>
                        {parsed.priority}
                      </Text>
                    </View>
                  ) : null}
                </View>
                {!parsed.timeDetected && !parsed.dueDateIso ? (
                  <View style={styles.timeGate}>
                    <Text style={styles.timeGateTitle}>Add a due time</Text>
                    <Text style={styles.timeGateHelp}>
                      No time was detected. Pick one so we can schedule a reminder.
                    </Text>
                    <InlineTimePickerField
                      value={manualTime}
                      onChange={(v) => setManualTime(v)}
                      placeholder="Tap to pick a time"
                    />
                  </View>
                ) : null}
                {!parsed.priorityDetected ? (
                  <View style={styles.timeGate}>
                    <Text style={styles.timeGateTitle}>Choose priority</Text>
                    <View style={styles.priorityRow}>
                      {(["LOW", "MEDIUM", "HIGH", "URGENT"] as Priority[]).map((p) => (
                        <Pressable
                          key={p}
                          style={[
                            styles.priorityChip,
                            (selectedPriority ?? parsed.priority) === p && styles.priorityChipOn,
                          ]}
                          onPress={() => setSelectedPriority(p)}
                        >
                          <Text
                            style={[
                              styles.priorityChipText,
                              (selectedPriority ?? parsed.priority) === p && styles.priorityChipTextOn,
                            ]}
                          >
                            {p}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                ) : null}
                <View style={styles.previewRow}>
                  <Text style={styles.previewLabel}>Category</Text>
                  <Text style={styles.previewValue}>{parsed.category ?? "Not detected"}</Text>
                </View>
                <View style={styles.previewRow}>
                  <Text style={styles.previewLabel}>Confidence</Text>
                  <View
                    style={[styles.miniPill, { backgroundColor: confidenceStyle.backgroundColor }]}
                  >
                    <Text style={[styles.miniPillText, { color: confidenceStyle.color }]}>
                      {parsed.confidence}%
                    </Text>
                  </View>
                </View>
              </View>

              {(parsed.dueDateYmd?.trim() || parsed.dueDateIso) && !parsed.dueTime ? (
                <View style={styles.timeGate}>
                  <Text style={styles.timeGateTitle}>Time on that day</Text>
                  <Text style={styles.timeGateHelp}>
                    A date was detected but no time. Add a time or choose all-day before saving.
                  </Text>
                  <InlineTimePickerField
                    value={manualTime}
                    onChange={(v) => {
                      setManualTime(v);
                      setAllDay(false);
                    }}
                    placeholder="Tap to pick a time"
                    baseYmd={
                      parsed.dueDateYmd?.trim() ||
                      (parsed.dueDateIso
                        ? ymdFromLocalDate(new Date(parsed.dueDateIso))
                        : undefined)
                    }
                  />
                  <Pressable
                    style={({ pressed }) => [
                      styles.allDayBtn,
                      allDay && styles.allDayBtnOn,
                      pressed && { opacity: 0.9 },
                    ]}
                    onPress={() => {
                      setAllDay((prev) => {
                        const next = !prev;
                        if (next) setManualTime("");
                        return next;
                      });
                    }}
                  >
                    <Text style={[styles.allDayText, allDay && styles.allDayTextOn]}>
                      All day (no specific time)
                    </Text>
                  </Pressable>
                </View>
              ) : null}

              <Pressable
                style={({ pressed }) => [
                  styles.saveWrap,
                  (!canSave || saving) && styles.saveDisabled,
                  pressed && styles.btnPressed,
                ]}
                onPress={() => void save()}
                disabled={!canSave || saving}
              >
                <LinearGradient
                  colors={["#16A34A", "#15803D"]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 0, y: 1 }}
                  style={styles.saveGrad}
                >
                  {saving ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.saveText}>Save task</Text>
                  )}
                </LinearGradient>
              </Pressable>
            </View>
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>

      {listening ? (
        <View style={styles.recordBar}>
          <Text style={styles.listenLabel}>Listening…</Text>
          <ListeningWaveform />
          <Pressable
            style={({ pressed }) => [styles.stopBtn, pressed && { opacity: 0.9 }]}
            onPress={() => stop()}
          >
            <Text style={styles.stopBtnText}>Stop</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.composerBar}>
          <TextInput
            style={styles.input}
            placeholder="Spoken text appears here — edit if needed"
            placeholderTextColor="#94a3b8"
            value={transcript}
            onChangeText={(t) => {
              setTranscript(t);
              setParsed(null);
            }}
            multiline
          />
          <View style={styles.composerActions}>
            <View style={{ flex: 1 }}>
              <GradientPrimaryButton
                title="Parse task"
                onPress={() => void runParse(transcript)}
                disabled={busy || !transcript.trim()}
                loading={busy}
                height={48}
              />
            </View>
            <Pressable
              style={({ pressed }) => [
                styles.micFab,
                !speechSupported && styles.micFabDisabled,
                pressed && { opacity: 0.92 },
              ]}
              onPress={() => startListening()}
              disabled={busy || !speechSupported}
            >
              <Text style={styles.micFabText}>🎤</Text>
            </Pressable>
          </View>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  thread: {
    flex: 1,
  },
  threadContent: {
    padding: 16,
    paddingBottom: 24,
    gap: 16,
  },
  rowStart: {
    flexDirection: "row",
    justifyContent: "flex-start",
  },
  rowEnd: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  bubbleAssistant: {
    maxWidth: "88%",
    backgroundColor: colors.surface,
    borderRadius: radii.xl,
    borderTopLeftRadius: 8,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow,
  },
  bubbleAssistantWide: {
    maxWidth: "92%",
    backgroundColor: colors.surface,
    borderRadius: radii.xl,
    borderTopLeftRadius: 8,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 12,
    ...shadow,
  },
  thinking: {
    minWidth: 120,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
  },
  bubbleAssistantText: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 22,
  },
  expoGoHint: {
    marginTop: 10,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textMuted,
  },
  expoGoHintEm: {
    fontWeight: "700",
    color: colors.text,
  },
  bubbleUser: {
    maxWidth: "88%",
    borderRadius: radii.xl,
    borderBottomRightRadius: 8,
    padding: 16,
  },
  bubbleUserText: {
    color: "#fff",
    fontSize: 15,
    lineHeight: 22,
  },
  previewCard: {
    backgroundColor: colors.bg,
    borderRadius: radii.md,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 8,
  },
  previewRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  previewLabel: {
    fontSize: 12,
    fontWeight: "500",
    color: colors.textMuted,
  },
  previewValue: {
    fontSize: 14,
    color: colors.text,
    flexShrink: 1,
    textAlign: "right",
  },
  previewValueStrong: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
    flexShrink: 1,
    textAlign: "right",
  },
  miniPill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.pill,
  },
  miniPillText: {
    fontSize: 11,
    fontWeight: "700",
  },
  timeGate: {
    marginTop: 4,
    padding: 12,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 8,
  },
  timeGateTitle: {
    fontWeight: "600",
    fontSize: 14,
    color: colors.text,
  },
  timeGateHelp: {
    fontSize: 13,
    color: colors.textMuted,
    lineHeight: 18,
  },
  allDayBtn: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  allDayBtnOn: {
    borderColor: colors.primary,
    backgroundColor: "#EEF7FF",
  },
  allDayText: {
    textAlign: "center",
    fontWeight: "600",
    color: colors.textMuted,
    fontSize: 14,
  },
  allDayTextOn: {
    color: colors.primaryDark,
  },
  priorityRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  priorityChip: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  priorityChipOn: {
    backgroundColor: "#EEF7FF",
    borderColor: colors.primary,
  },
  priorityChipText: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.textMuted,
  },
  priorityChipTextOn: {
    color: colors.primaryDark,
  },
  saveWrap: {
    borderRadius: radii.md,
    overflow: "hidden",
    ...shadow,
  },
  saveDisabled: {
    opacity: 0.45,
  },
  saveGrad: {
    height: 48,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  saveText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 16,
  },
  error: {
    color: colors.danger,
    fontSize: 14,
    textAlign: "center",
  },
  recordBar: {
    padding: 16,
    paddingBottom: 28,
    backgroundColor: colors.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    alignItems: "center",
    gap: 12,
  },
  listenLabel: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.text,
  },
  stopBtn: {
    backgroundColor: "#DC2626",
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: radii.pill,
  },
  stopBtnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 16,
  },
  composerBar: {
    padding: 16,
    paddingBottom: 24,
    backgroundColor: colors.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: 10,
  },
  input: {
    minHeight: 88,
    maxHeight: 160,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    backgroundColor: colors.surface,
    color: colors.text,
    textAlignVertical: "top",
  },
  composerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  micFab: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    ...shadow,
  },
  micFabDisabled: {
    opacity: 0.45,
  },
  micFabText: {
    fontSize: 24,
  },
  btnPressed: {
    opacity: 0.92,
    transform: [{ scale: 0.97 }],
  },
});
