import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { LinearGradient } from "expo-linear-gradient";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { InlineTimePickerField, TaskFormDueDateRow } from "../../components/DueDateTimePickers";
import { ListeningWaveform } from "../../components/ListeningWaveform";
import { ScreenHeader } from "../../components/ScreenHeader";
import { GradientPrimaryButton } from "../../components/GradientPrimaryButton";
import { colors, radii, shadow } from "../../constants/theme";
import { useDeviceSpeechRecognition } from "../../hooks/useDeviceSpeechRecognition";
import type { MainStackParamList } from "../../navigation/MainStack";
import {
  createTaskFromParsedNatural,
  formatTaskCreatedToast,
  initialPreviewFieldsFromParsed,
  shouldAutoCreateFromClarityIndex,
} from "../../services/parsedNaturalTask";
import { parseTaskText } from "../../services/tasksApi";
import type { ParsedTask, Priority } from "../../types/models";
import { ymdFromLocalDate } from "../../utils/datetimeValidation";

type Props = NativeStackScreenProps<MainStackParamList, "VoiceTask">;

const intro =
  "Tap the microphone to speak your task. Your device converts speech to text (no cloud). Then we extract title, due date, time, and priority — same parser as chat.";

export function VoiceTaskScreen({ navigation }: Props) {
  const [transcript, setTranscript] = useState("");
  const [parsed, setParsed] = useState<ParsedTask | null>(null);
  const [previewEpoch, setPreviewEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [autoCreating, setAutoCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualTime, setManualTime] = useState("");
  const [manualDateYmd, setManualDateYmd] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [selectedPriority, setSelectedPriority] = useState<Priority | null>(null);
  const [reminderEnabled, setReminderEnabled] = useState(true);

  useEffect(() => {
    if (!parsed) return;
    const init = initialPreviewFieldsFromParsed(parsed);
    setTitleDraft(init.titleDraft);
    setManualDateYmd(init.manualDateYmd);
    setManualTime(init.manualTime);
    setAllDay(false);
    setReminderEnabled(true);
    setSelectedPriority(null);
  }, [parsed, previewEpoch]);

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
      if (shouldAutoCreateFromClarityIndex(result.confidence)) {
        setAutoCreating(true);
        try {
          const { reminder } = await createTaskFromParsedNatural({
            parsed: result,
            title: result.title,
            manualDateYmd: "",
            manualTime: "",
            allDay: false,
            selectedPriority: null,
            reminderEnabled: true,
            source: "VOICE",
            description: t || null,
          });
          setTranscript("");
          navigation.navigate("TaskList", {
            toast: formatTaskCreatedToast(reminder),
            toastTone: reminder.kind === "scheduled" ? "success" : "warning",
          });
        } catch (e) {
          setError(e instanceof Error ? e.message : "Could not create task. Try reviewing the details below.");
          setParsed(result);
          setPreviewEpoch((x) => x + 1);
        } finally {
          setAutoCreating(false);
        }
      } else {
        setParsed(result);
        setPreviewEpoch((x) => x + 1);
      }
    } catch {
      setError("Could not parse that text. Try editing it or speak more clearly.");
      setParsed(null);
    } finally {
      setBusy(false);
    }
  }, [navigation]);

  const { start, stop, listening, speechSupported } = useDeviceSpeechRecognition({
    onTranscriptChange: setTranscript,
    onError: (m) => setError(m),
  });

  const startListening = () => {
    setError(null);
    void start(transcript);
  };

  const cancelPreview = () => {
    setParsed(null);
    setError(null);
  };

  const confirmPreview = async () => {
    if (!parsed) return;
    if (!titleDraft.trim()) {
      setError("Please enter a task title.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { reminder } = await createTaskFromParsedNatural({
        parsed,
        title: titleDraft,
        manualDateYmd,
        manualTime,
        allDay,
        selectedPriority,
        reminderEnabled,
        source: "VOICE",
        description: transcript.trim() ? transcript.trim() : null,
      });
      setTranscript("");
      setParsed(null);
      navigation.navigate("TaskList", {
        toast: formatTaskCreatedToast(reminder),
        toastTone: reminder.kind === "scheduled" ? "success" : "warning",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save task.");
    } finally {
      setSaving(false);
    }
  };

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

        {busy || autoCreating ? (
          <View style={styles.rowStart}>
            <View style={[styles.bubbleAssistant, styles.thinking]}>
              <ActivityIndicator color={colors.primary} />
              {autoCreating ? (
                <Text style={styles.thinkingCaption}>Creating your task…</Text>
              ) : null}
            </View>
          </View>
        ) : null}

        {parsed ? (
          <View style={styles.rowStart}>
            <View style={styles.bubbleAssistantWide}>
              <Text style={styles.bubbleAssistantText}>
                Almost there — review your task, adjust anything missing, then create it.
              </Text>

              <View style={styles.previewCard}>
                <Text style={styles.fieldLabel}>Title</Text>
                <TextInput
                  style={styles.titleInput}
                  value={titleDraft}
                  onChangeText={setTitleDraft}
                  placeholder="Task title"
                  placeholderTextColor="#94a3b8"
                />

                <TaskFormDueDateRow
                  valueYmd={manualDateYmd}
                  onChangeYmd={setManualDateYmd}
                  onClear={() => setManualDateYmd("")}
                  label="Due date"
                />

                <Text style={styles.fieldLabel}>Due time</Text>
                <InlineTimePickerField
                  value={manualTime}
                  onChange={(v) => {
                    setManualTime(v);
                    setAllDay(false);
                  }}
                  placeholder="Optional — tap to pick a time"
                  baseYmd={
                    manualDateYmd.trim() ||
                    parsed.dueDateYmd?.trim() ||
                    (parsed.dueDateIso ? ymdFromLocalDate(new Date(parsed.dueDateIso)) : undefined)
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

                <Text style={styles.fieldLabel}>Priority</Text>
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

                <View style={styles.reminderRow}>
                  <View style={styles.reminderTextCol}>
                    <Text style={styles.reminderLabel}>Remind me</Text>
                    <Text style={styles.reminderHint}>Uses your due date and time when set</Text>
                  </View>
                  <Switch
                    value={reminderEnabled}
                    onValueChange={setReminderEnabled}
                    trackColor={{ false: colors.border, true: "#B7DCFF" }}
                    thumbColor={reminderEnabled ? colors.primary : "#f4f4f5"}
                  />
                </View>

                <View style={styles.previewRow}>
                  <Text style={styles.previewLabel}>Category</Text>
                  <Text style={styles.previewValue}>{parsed.category ?? "Not detected"}</Text>
                </View>
              </View>

              <Pressable
                style={({ pressed }) => [styles.saveWrap, pressed && styles.btnPressed]}
                onPress={() => void confirmPreview()}
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
                    <Text style={styles.saveText}>Create task</Text>
                  )}
                </LinearGradient>
              </Pressable>

              <Pressable
                style={({ pressed }) => [styles.cancelBtn, pressed && styles.btnPressed]}
                onPress={cancelPreview}
                disabled={saving}
              >
                <Text style={styles.cancelBtnText}>Cancel</Text>
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
            editable={!parsed}
          />
          <View style={styles.composerActions}>
            <View style={{ flex: 1 }}>
              <GradientPrimaryButton
                title="Parse task"
                onPress={() => void runParse(transcript)}
                disabled={busy || autoCreating || !transcript.trim() || !!parsed}
                loading={busy || autoCreating}
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
              disabled={busy || autoCreating || !speechSupported || !!parsed}
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
    gap: 8,
  },
  thinkingCaption: {
    fontSize: 13,
    color: colors.textMuted,
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
    gap: 10,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textMuted,
    marginBottom: -4,
  },
  titleInput: {
    minHeight: 44,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
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
  reminderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    marginTop: 4,
  },
  reminderTextCol: {
    flex: 1,
  },
  reminderLabel: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.text,
  },
  reminderHint: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
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
  cancelBtn: {
    height: 48,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  cancelBtnText: {
    color: colors.text,
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
