import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { LinearGradient } from "expo-linear-gradient";
import { useState } from "react";
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
import { ScreenHeader } from "../../components/ScreenHeader";
import { SendIcon } from "../../components/icons/SendIcon";
import { colors, radii, shadow } from "../../constants/theme";
import type { MainStackParamList } from "../../navigation/MainStack";
import { createTask, parseTaskText } from "../../services/tasksApi";
import type { ParsedTask, Priority } from "../../types/models";
import { priorityPill } from "../../utils/priorityColors";

type Props = NativeStackScreenProps<MainStackParamList, "ChatTask">;

const intro = `Hi! Tell me what you need to do, and I'll help you organize it. Try something like "Review budget tomorrow at 2pm"`;

export function ChatTaskScreen({ navigation }: Props) {
  const [draft, setDraft] = useState("");
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedTask | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const msg = draft.trim();
    if (!msg || busy) return;
    setDraft("");
    setLastSent(msg);
    setParsed(null);
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
    setSaving(true);
    setError(null);
    try {
      await createTask({
        title: parsed.title,
        description: null,
        dueDate: parsed.dueDateIso,
        dueTime: parsed.dueTime,
        priority: parsed.priority as Priority,
        category: parsed.category,
        source: "CHAT",
        confidence: parsed.confidence,
      });
      setLastSent(null);
      setParsed(null);
      navigation.navigate("TaskList");
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
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}
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
                    {parsed.dueDateText ?? "Not detected"}
                    {parsed.dueTime ? ` · ${parsed.dueTime}` : ""}
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
      </ScrollView>

      <View style={styles.composerBar}>
        <View style={styles.composerRow}>
          <TextInput
            style={styles.input}
            placeholder="Describe your task..."
            placeholderTextColor="#94a3b8"
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={() => void send()}
            returnKeyType="send"
          />
          <Pressable
            style={({ pressed }) => [styles.sendBtn, pressed && styles.btnPressed]}
            onPress={() => void send()}
            disabled={busy || !draft.trim()}
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
  },
  composerRow: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-end",
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
