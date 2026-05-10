import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { ScreenHeader } from "../../components/ScreenHeader";
import { colors, radii, shadow } from "../../constants/theme";
import type { MainStackParamList } from "../../navigation/MainStack";
import { createTask, parseTaskText } from "../../services/tasksApi";
import type { ParsedTask, Priority } from "../../types/models";
import { priorityPill } from "../../utils/priorityColors";

type Props = NativeStackScreenProps<MainStackParamList, "VoiceTask">;

export function VoiceTaskScreen({ navigation }: Props) {
  const [transcript, setTranscript] = useState("");
  const [parsed, setParsed] = useState<ParsedTask | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runParser = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await parseTaskText(transcript.trim());
      setParsed(result);
    } catch {
      setError("Could not parse that text. Try speaking more clearly or edit the text.");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!parsed) return;
    if (!parsed.title.trim()) {
      setError("Task title is missing. Refine the text and parse again.");
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
        source: "VOICE",
        confidence: parsed.confidence,
      });
      setTranscript("");
      setParsed(null);
      navigation.navigate("TaskList");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save task.");
    } finally {
      setSaving(false);
    }
  };

  const parsedPill = parsed ? priorityPill(parsed.priority as Priority) : null;

  return (
    <View style={styles.root}>
      <ScreenHeader title="Voice task" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.heading}>Voice capture</Text>
      <Text style={styles.help}>
        Use your device microphone on the keyboard to dictate, or type what you would have said. Tap
        &quot;Parse&quot; to extract task fields.
      </Text>
      <TextInput
        style={styles.input}
        multiline
        placeholder="Spoken task appears here…"
        placeholderTextColor="#94a3b8"
        value={transcript}
        onChangeText={setTranscript}
      />
      <Pressable
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        onPress={() => void runParser()}
        disabled={busy || !transcript.trim()}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Parse</Text>}
      </Pressable>

      {parsed ? (
        <View style={styles.preview}>
          <Text style={styles.previewTitle}>Extracted preview</Text>
          {parsed.needsConfirmation ? (
            <Text style={styles.warn}>
              Confidence {parsed.confidence}% — please review before saving.
            </Text>
          ) : null}
          <Text style={styles.line}>
            <Text style={styles.bold}>Title: </Text>
            {parsed.title}
          </Text>
          <Text style={styles.line}>
            <Text style={styles.bold}>Due: </Text>
            {parsed.dueDateText ?? "Not detected"}
            {parsed.dueTime ? ` · ${parsed.dueTime}` : ""}
          </Text>
          <Text style={styles.line}>
            <Text style={styles.bold}>Priority: </Text>
            {parsed.priority}
          </Text>
          {parsedPill ? (
            <View style={[styles.badge, { backgroundColor: parsedPill.backgroundColor }]}>
              <Text style={[styles.badgeText, { color: parsedPill.color }]}>{parsed.priority}</Text>
            </View>
          ) : null}
          <Pressable
            style={({ pressed }) => [styles.save, saving && styles.saveDisabled, pressed && styles.buttonPressed]}
            onPress={() => void save()}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.saveText}>Save task</Text>
            )}
          </Pressable>
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    padding: 20,
    backgroundColor: colors.bg,
    paddingBottom: 32,
    gap: 12,
  },
  heading: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
  },
  help: {
    color: colors.textMuted,
    fontSize: 14,
  },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: 12,
    minHeight: 140,
    textAlignVertical: "top",
    fontSize: 16,
  },
  button: {
    backgroundColor: colors.primary,
    paddingVertical: 14,
    borderRadius: radii.md,
    alignItems: "center",
    ...shadow,
  },
  buttonText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 16,
  },
  preview: {
    marginTop: 8,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 8,
    ...shadow,
  },
  previewTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
  },
  warn: {
    color: "#b45309",
    fontSize: 13,
  },
  line: {
    fontSize: 15,
    color: colors.text,
  },
  bold: {
    fontWeight: "700",
  },
  badge: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  badgeText: {
    fontWeight: "700",
    fontSize: 12,
  },
  save: {
    marginTop: 8,
    backgroundColor: colors.success,
    paddingVertical: 12,
    borderRadius: radii.md,
    alignItems: "center",
  },
  saveDisabled: {
    opacity: 0.5,
  },
  saveText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 16,
  },
  error: {
    color: colors.danger,
  },
  buttonPressed: {
    opacity: 0.92,
    transform: [{ scale: 0.985 }],
  },
});
