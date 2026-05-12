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
import { InlineTimePickerField, TaskFormDueDateRow } from "../../components/DueDateTimePickers";
import { ListeningWaveform } from "../../components/ListeningWaveform";
import { ScreenHeader } from "../../components/ScreenHeader";
import { MicIcon } from "../../components/icons/MicIcon";
import { SendIcon } from "../../components/icons/SendIcon";
import { colors, radii, shadow } from "../../constants/theme";
import { useDeviceSpeechRecognition } from "../../hooks/useDeviceSpeechRecognition";
import type { MainStackParamList } from "../../navigation/MainStack";
import { createTaskWithReminder } from "../../services/createTaskWithReminder";
import { reminderFeedbackText } from "../../services/reminders";
import { parseTaskText } from "../../services/tasksApi";
import type { ParsedTask, Priority } from "../../types/models";
import { dueDateAndTimeForSave, validateDueDateNotPast, ymdFromLocalDate } from "../../utils/datetimeValidation";
import { priorityPill } from "../../utils/priorityColors";

type Props = NativeStackScreenProps<MainStackParamList, "ChatTask">;

const intro = `Hi! Tell me what you need to do, and I'll help you organize it. Try something like "Review budget tomorrow at 2pm"`;

function hasParserDate(parsed: ParsedTask): boolean {
  return !!(parsed.dueDateYmd?.trim() || parsed.dueDateIso?.trim());
}

export function ChatTaskScreen({ navigation }: Props) {
  const [draft, setDraft] = useState("");
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedTask | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [selectedPriority, setSelectedPriority] = useState<Priority | null>(null);
  const [manualTime, setManualTime] = useState("");
  const [manualDateYmd, setManualDateYmd] = useState("");

  const { start, stop, listening, speechSupported } = useDeviceSpeechRecognition({
    onTranscriptChange: setDraft,
    onError: (m) => setSpeechError(m),
  });

  const onMicPress = useCallback(async () => {
    setSpeechError(null);
    await start(draft);
  }, [draft, start]);

  const send = async () => {
    const msg = draft.trim();
    if (!msg || busy) return;
    setSpeechError(null);
    setDraft("");
    setLastSent(msg);
    setParsed(null);
    setSelectedPriority(null);
    setManualTime("");
    setManualDateYmd("");
    setError(null);
    setBusy(true);
    try {
      const result = await parseTaskText(msg);
      setParsed(result);
    } catch {
      setError("I could not understand the task clearly. Try adding a clearer title and due date.");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!parsed) return;
    if (!parsed.title.trim()) {
      setError("Task title is missing. Please edit your message and send again.");
      return;
    }
    const priorityOut = selectedPriority ?? (parsed.priority as Priority);
    const rawTime = `${manualTime.trim() || (parsed.dueTime ?? "")}`.trim();
    const dueTimeForSave = rawTime === "" ? null : rawTime;
    if (!parsed.priorityDetected && !selectedPriority) {
      setError("Please choose a priority.");
      return;
    }
    if (!parsed.timeDetected && !dueTimeForSave) {
      setError("Please provide a due time.");
      return;
    }
    const parserHasDate = hasParserDate(parsed);
    if (!parserHasDate && !parsed.timeDetected) {
      if (!manualDateYmd.trim()) {
        setError("Please pick a due date.");
        return;
      }
    }
    const pickerYmd = manualDateYmd.trim() || parsed.dueDateYmd?.trim() || "";
    const { dueDateIso: dueDateOut, dueTime: dueTimeNormalized } = dueDateAndTimeForSave({
      pickerYmd: pickerYmd || undefined,
      parsedDueDateIso: pickerYmd ? null : parsed.dueDateIso,
      rawDueTime: dueTimeForSave,
    });
    if (dueTimeNormalized && !dueDateOut) {
      setError(
        "Couldn't read that due time for reminders. Tap to pick a time, or phrase it like 3 PM or 15:30.",
      );
      return;
    }
    const dateErr = validateDueDateNotPast(dueDateOut, dueTimeNormalized);
    if (dateErr) {
      setError(dateErr);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const { reminder } = await createTaskWithReminder(
        {
          title: parsed.title.trim(),
          description: null,
          dueDate: dueDateOut,
          dueTime: dueTimeNormalized,
          priority: priorityOut,
          category: parsed.category,
          source: "CHAT",
          confidence: parsed.confidence,
        },
        {
          reminderEnabled: true,
          reminderHint: { dueDateIso: dueDateOut, dueTime: dueTimeNormalized },
        },
      );
      setLastSent(null);
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

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 12}
    >
      <ScreenHeader title="Chat task" onBack={() => navigation.goBack()} />

      <ScrollView
        style={styles.thread}
        contentContainerStyle={styles.threadContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.rowStart}>
          <View style={styles.bubbleAssistant}>
            <Text style={styles.bubbleAssistantText}>{intro}</Text>
          </View>
        </View>

        {lastSent ? (
          <View style={styles.rowEnd}>
            <LinearGradient
              colors={["#1D99FF", "#47AFFF"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 0, y: 1 }}
              style={styles.bubbleUser}
            >
              <Text style={styles.bubbleUserText}>{lastSent}</Text>
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
                  <Text style={styles.previewValueStrong} numberOfLines={2}>
                    {parsed.title}
                  </Text>
                </View>
                <View style={styles.previewRow}>
                  <Text style={styles.previewLabel}>Due</Text>
                  <Text style={styles.previewValue}>
                    {parsed.dueSummary ??
                      (parsed.dueDateText || parsed.dueTime
                        ? [parsed.dueDateText, parsed.dueTime].filter(Boolean).join(" · ")
                        : "Not detected")}
                  </Text>
                </View>
                <View style={styles.previewRow}>
                  <Text style={styles.previewLabel}>Priority</Text>
                  {previewPill ? (
                    <View style={[styles.miniPill, { backgroundColor: previewPill.backgroundColor }]}>
                      <Text style={[styles.miniPillText, { color: previewPill.color }]}>
                        {parsed.priority}
                      </Text>
                    </View>
                  ) : null}
                </View>
                {!parsed.priorityDetected ? (
                  <View style={styles.followUpWrap}>
                    <Text style={styles.followUpLabel}>Please add priority</Text>
                    <View style={styles.followUpRow}>
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
                {!parsed.timeDetected ? (
                  <View style={styles.followUpWrap}>
                    <Text style={styles.followUpLabel}>
                      {hasParserDate(parsed)
                        ? "Please add due time"
                        : "Please add due date and time"}
                    </Text>
                    {!hasParserDate(parsed) ? (
                      <TaskFormDueDateRow
                        valueYmd={manualDateYmd}
                        onChangeYmd={setManualDateYmd}
                        onClear={() => setManualDateYmd("")}
                        label="Due date"
                      />
                    ) : null}
                    <InlineTimePickerField
                      value={manualTime}
                      onChange={setManualTime}
                      placeholder="Tap to pick a time"
                      style={styles.followUpInput}
                      baseYmd={
                        manualDateYmd.trim() ||
                        parsed.dueDateYmd?.trim() ||
                        (parsed.dueDateIso
                          ? ymdFromLocalDate(new Date(parsed.dueDateIso))
                          : undefined)
                      }
                    />
                  </View>
                ) : null}
                <View style={styles.previewRow}>
                  <Text style={styles.previewLabel}>Category</Text>
                  <Text style={styles.previewValue}>{parsed.category ?? "Not detected"}</Text>
                </View>
                <View style={styles.previewRow}>
                  <Text style={styles.previewLabel}>Confidence</Text>
                  <View style={[styles.miniPill, { backgroundColor: confidenceStyle.backgroundColor }]}>
                    <Text style={[styles.miniPillText, { color: confidenceStyle.color }]}>
                      {parsed.confidence}%
                    </Text>
                  </View>
                </View>
              </View>

              <Pressable
                style={({ pressed }) => [styles.saveWrap, pressed && styles.btnPressed]}
                onPress={() => void save()}
                disabled={saving}
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
        {speechError ? <Text style={styles.error}>{speechError}</Text> : null}
      </ScrollView>

      <View style={styles.composerBar}>
        {listening ? (
          <View style={styles.listenBanner}>
            <Text style={styles.listenLabel}>Listening…</Text>
            <ListeningWaveform />
          </View>
        ) : null}
        <View style={styles.composerRow}>
          <TextInput
            style={styles.input}
            placeholder="Describe your task..."
            placeholderTextColor="#94a3b8"
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={() => void send()}
            returnKeyType="send"
            editable={!listening}
          />
          <Pressable
            style={({ pressed }) => [
              listening ? styles.micStopBtn : styles.micBtn,
              !speechSupported && !listening && styles.micBtnDisabled,
              pressed && styles.btnPressed,
            ]}
            onPress={() => (listening ? stop() : void onMicPress())}
            disabled={busy || (!listening && !speechSupported)}
            accessibilityLabel={listening ? "Stop listening" : "Voice input"}
          >
            {listening ? (
              <Text style={styles.micStopText}>Stop</Text>
            ) : (
              <MicIcon color={colors.primary} size={22} />
            )}
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.sendBtn, pressed && styles.btnPressed]}
            onPress={() => void send()}
            disabled={busy || listening || !draft.trim()}
          >
            <LinearGradient
              colors={["#1D99FF", "#47AFFF"]}
              style={styles.sendGrad}
              start={{ x: 0, y: 0 }}
              end={{ x: 0, y: 1 }}
            >
              {busy ? <ActivityIndicator color="#fff" size="small" /> : <SendIcon />}
            </LinearGradient>
          </Pressable>
        </View>
      </View>
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
    maxWidth: "85%",
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
    minWidth: 56,
    alignItems: "center",
    justifyContent: "center",
  },
  bubbleAssistantText: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 22,
  },
  bubbleUser: {
    maxWidth: "85%",
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
  followUpWrap: {
    marginTop: 6,
    gap: 8,
  },
  followUpLabel: {
    fontSize: 12,
    color: colors.textMuted,
    fontWeight: "600",
  },
  followUpRow: {
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
  followUpInput: {
    height: 44,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    color: colors.text,
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
  saveWrap: {
    borderRadius: radii.md,
    overflow: "hidden",
    ...shadow,
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
  composerBar: {
    padding: 16,
    paddingBottom: 24,
    backgroundColor: colors.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: 10,
  },
  listenBanner: {
    alignItems: "center",
    gap: 8,
    paddingVertical: 4,
  },
  listenLabel: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.text,
  },
  composerRow: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-end",
  },
  micBtn: {
    width: 48,
    height: 48,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  micBtnDisabled: {
    opacity: 0.45,
  },
  micStopBtn: {
    minWidth: 52,
    height: 48,
    paddingHorizontal: 12,
    borderRadius: radii.md,
    backgroundColor: "#FEE2E2",
    borderWidth: 1,
    borderColor: "#FECACA",
    alignItems: "center",
    justifyContent: "center",
  },
  micStopText: {
    color: "#B91C1C",
    fontWeight: "700",
    fontSize: 14,
  },
  input: {
    flex: 1,
    minHeight: 48,
    maxHeight: 120,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    backgroundColor: colors.surface,
    color: colors.text,
  },
  sendBtn: {
    borderRadius: radii.md,
    overflow: "hidden",
  },
  sendGrad: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  btnPressed: {
    opacity: 0.92,
    transform: [{ scale: 0.97 }],
  },
});
