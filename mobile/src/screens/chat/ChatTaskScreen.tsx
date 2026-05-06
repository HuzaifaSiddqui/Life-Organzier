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
import type { MainStackParamList } from "../../navigation/MainStack";
import { createTask, parseTaskText } from "../../services/tasksApi";
import type { ParsedTask, Priority } from "../../types/models";
import { priorityColor } from "../../utils/priorityColors";

type Props = NativeStackScreenProps<MainStackParamList, "ChatTask">;

export function ChatTaskScreen({ navigation }: Props) {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<ParsedTask | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runParser = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await parseTaskText(text.trim());
      setParsed(result);
    } catch {
      setError("I could not understand the task clearly. Try adding a clearer title and due date.");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!parsed) return;
    if (parsed.confidence < 50) {
      setError("Confidence is low. Refine your message or save a manual task instead.");
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
      setText("");
      setParsed(null);
      navigation.navigate("TaskList");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save task.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.help}>
        Describe your task in natural language. We will extract title, due date, time, priority, and
        category.
      </Text>
      <TextInput
        style={styles.input}
        multiline
        placeholder='Example: "Submit AI assignment tomorrow at 5 PM high priority"'
        value={text}
        onChangeText={setText}
      />
      <Pressable style={styles.button} onPress={() => void runParser()} disabled={busy || !text.trim()}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Parse task</Text>}
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
          <Text style={styles.line}>
            <Text style={styles.bold}>Category: </Text>
            {parsed.category ?? "Not detected"}
          </Text>
          <View style={styles.badgeRow}>
            <View style={[styles.badge, { backgroundColor: priorityColor(parsed.priority as Priority) }]}>
              <Text style={styles.badgeText}>{parsed.priority}</Text>
            </View>
            <Text style={styles.confidence}>{parsed.confidence}% match</Text>
          </View>
          <Pressable
            style={[styles.save, (parsed.confidence < 50 || saving) && styles.saveDisabled]}
            onPress={() => void save()}
            disabled={parsed.confidence < 50 || saving}
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
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    backgroundColor: "#f7f8fb",
    paddingBottom: 32,
    gap: 12,
  },
  help: {
    color: "#475569",
    fontSize: 14,
  },
  input: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 12,
    padding: 12,
    minHeight: 120,
    textAlignVertical: "top",
    fontSize: 16,
  },
  button: {
    backgroundColor: "#2563eb",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  buttonText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 16,
  },
  preview: {
    marginTop: 8,
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    gap: 8,
  },
  previewTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#0f172a",
  },
  warn: {
    color: "#b45309",
    fontSize: 13,
  },
  line: {
    fontSize: 15,
    color: "#0f172a",
  },
  bold: {
    fontWeight: "700",
  },
  badgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 4,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  badgeText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 12,
  },
  confidence: {
    color: "#64748b",
    fontSize: 13,
  },
  save: {
    marginTop: 8,
    backgroundColor: "#16a34a",
    paddingVertical: 12,
    borderRadius: 10,
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
    color: "#b91c1c",
  },
});
