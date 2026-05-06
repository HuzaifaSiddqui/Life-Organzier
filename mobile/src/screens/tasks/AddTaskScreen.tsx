import { zodResolver } from "@hookform/resolvers/zod";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
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
import { createTask } from "../../services/tasksApi";
import type { Priority } from "../../types/models";
import { z } from "zod";

const priorities: Priority[] = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const statuses = ["PENDING", "IN_PROGRESS", "COMPLETED"] as const;

const schema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  dueDate: z.string().optional(),
  dueTime: z.string().optional(),
  category: z.string().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]),
  status: z.enum(statuses),
});

type FormValues = z.infer<typeof schema>;

type Props = NativeStackScreenProps<MainStackParamList, "AddTask">;

export function AddTaskScreen({ navigation }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { control, handleSubmit, setValue, watch } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: "",
      description: "",
      dueDate: "",
      dueTime: "",
      category: "",
      priority: "MEDIUM",
      status: "PENDING",
    },
  });

  const priority = watch("priority");
  const status = watch("status");

  const onSubmit = handleSubmit(async (values) => {
    setBusy(true);
    setError(null);
    try {
      const dueDate =
        values.dueDate && values.dueDate.trim().length > 0
          ? new Date(`${values.dueDate.trim()}T00:00:00`).toISOString()
          : null;
      await createTask({
        title: values.title.trim(),
        description: values.description?.trim() || null,
        dueDate,
        dueTime: values.dueTime?.trim() || null,
        category: values.category?.trim() || null,
        priority: values.priority,
        status: values.status,
        source: "MANUAL",
      });
      navigation.goBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save task.");
    } finally {
      setBusy(false);
    }
  });

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Controller
        control={control}
        name="title"
        render={({ field, fieldState }) => (
          <View style={styles.field}>
            <Text style={styles.label}>Title *</Text>
            <TextInput style={styles.input} placeholder="What do you need to do?" {...field} />
            {fieldState.error ? (
              <Text style={styles.fieldError}>{fieldState.error.message}</Text>
            ) : null}
          </View>
        )}
      />
      <Controller
        control={control}
        name="description"
        render={({ field }) => (
          <View style={styles.field}>
            <Text style={styles.label}>Description</Text>
            <TextInput
              style={[styles.input, styles.multiline]}
              multiline
              placeholder="Optional details"
              {...field}
            />
          </View>
        )}
      />
      <Controller
        control={control}
        name="dueDate"
        render={({ field }) => (
          <View style={styles.field}>
            <Text style={styles.label}>Due date (YYYY-MM-DD)</Text>
            <TextInput style={styles.input} placeholder="2026-05-12" {...field} />
          </View>
        )}
      />
      <Controller
        control={control}
        name="dueTime"
        render={({ field }) => (
          <View style={styles.field}>
            <Text style={styles.label}>Due time</Text>
            <TextInput style={styles.input} placeholder="5:30 PM" {...field} />
          </View>
        )}
      />
      <Controller
        control={control}
        name="category"
        render={({ field }) => (
          <View style={styles.field}>
            <Text style={styles.label}>Category</Text>
            <TextInput style={styles.input} placeholder="Work, Academic…" {...field} />
          </View>
        )}
      />

      <Text style={styles.label}>Priority *</Text>
      <View style={styles.chips}>
        {priorities.map((p) => (
          <Pressable
            key={p}
            onPress={() => setValue("priority", p)}
            style={[styles.chip, priority === p && styles.chipActive]}
          >
            <Text style={[styles.chipText, priority === p && styles.chipTextActive]}>{p}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>Status *</Text>
      <View style={styles.chips}>
        {statuses.map((s) => (
          <Pressable
            key={s}
            onPress={() => setValue("status", s)}
            style={[styles.chip, status === s && styles.chipActive]}
          >
            <Text style={[styles.chipText, status === s && styles.chipTextActive]}>
              {s.replace("_", " ")}
            </Text>
          </Pressable>
        ))}
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable style={styles.button} onPress={() => void onSubmit()} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Save task</Text>}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    backgroundColor: "#f7f8fb",
    gap: 10,
    paddingBottom: 32,
  },
  field: {
    marginBottom: 4,
  },
  label: {
    fontSize: 14,
    color: "#334155",
    marginBottom: 6,
    fontWeight: "500",
  },
  input: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  multiline: {
    minHeight: 80,
    textAlignVertical: "top",
  },
  fieldError: {
    color: "#b91c1c",
    marginTop: 4,
    fontSize: 13,
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 12,
  },
  chip: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#fff",
  },
  chipActive: {
    borderColor: "#2563eb",
    backgroundColor: "#eff6ff",
  },
  chipText: {
    color: "#0f172a",
    fontWeight: "500",
    fontSize: 13,
  },
  chipTextActive: {
    color: "#1d4ed8",
  },
  error: {
    color: "#b91c1c",
  },
  button: {
    backgroundColor: "#2563eb",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 8,
  },
  buttonText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 16,
  },
});
