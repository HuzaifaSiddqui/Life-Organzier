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
import { MicIcon } from "../../components/icons/MicIcon";
import { SendIcon } from "../../components/icons/SendIcon";
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

type Props = NativeStackScreenProps<MainStackParamList, "ChatTask">;

const intro = `Hi! Tell me what you need to do, and I'll help you organize it. Try something like "Review budget tomorrow at 2pm"`;

export function ChatTaskScreen({ navigation }: Props) {
  const [draft, setDraft] = useState("");
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedTask | null>(null);
  const [previewEpoch, setPreviewEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [autoCreating, setAutoCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [selectedPriority, setSelectedPriority] = useState<Priority | null>(null);
  const [manualTime, setManualTime] = useState("");
  const [manualDateYmd, setManualDateYmd] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [allDay, setAllDay] = useState(false);
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

  const { start, stop, listening, speechSupported } = useDeviceSpeechRecognition({
    onTranscriptChange: setDraft,
    onError: (m) => setSpeechError(m),
  });

  const onMicPress = useCallback(async () => {
    setSpeechError(null);
    await start(draft);
  }, [draft, start]);

  const cancelPreview = () => {
    setParsed(null);
    setError(null);
  };

  const send = async () => {
    const msg = draft.trim();
    if (!msg || busy || autoCreating) return;
    setSpeechError(null);
    setDraft("");
    setLastSent(msg);
    setParsed(null);
    setError(null);
    setBusy(true);
    try {
      const result = await parseTaskText(msg);
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
            source: "CHAT",
            description: null,
          });
          setLastSent(null);
          navigation.navigate("TaskList", {
            toast: formatTaskCreatedToast(reminder),
            toastTone: reminder.kind === "scheduled" ? "success" : "warning",
          });
        } catch (e) {
          setError(e instanceof Error ? e.message : "Could not create task. Try again or review the details.");
          setParsed(result);
          setPreviewEpoch((x) => x + 1);
        } finally {
          setAutoCreating(false);
        }
      } else {
        setParsed(result);
        setPreviewEpoch((x) => x + 1);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not parse the task. Please try again.");
    } finally {
      setBusy(false);
    }
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
        source: "CHAT",
        description: null,
      });
      setLastSent(null);
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
                  onChange={(t) => {
                    setManualTime(t);
                    setAllDay(false);
                  }}
                  placeholder="Optional — tap to pick a time"
                  style={styles.followUpInput}
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
            editable={!listening && !parsed && !busy && !autoCreating}
          />
          <Pressable
            style={({ pressed }) => [
              listening ? styles.micStopBtn : styles.micBtn,
              !speechSupported && !listening && styles.micBtnDisabled,
              pressed && styles.btnPressed,
            ]}
            onPress={() => (listening ? stop() : void onMicPress())}
            disabled={busy || autoCreating || (!listening && !speechSupported) || !!parsed}
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
            disabled={busy || autoCreating || listening || !draft.trim() || !!parsed}
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
    gap: 8,
    paddingVertical: 12,
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
