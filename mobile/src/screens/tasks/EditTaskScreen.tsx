import { zodResolver } from "@hookform/resolvers/zod";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useLayoutEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { BrandedBootLoader } from "../../components/BrandedBootLoader";
import { GradientPrimaryButton } from "../../components/GradientPrimaryButton";
import { ScreenHeader } from "../../components/ScreenHeader";
import { colors } from "../../constants/theme";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getTask, updateTask } from "../../services/tasksApi";
import type { Priority } from "../../types/models";
import { taskFormStyles } from "./taskFormStyles";
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

type Props = NativeStackScreenProps<MainStackParamList, "EditTask">;

function toDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

export function EditTaskScreen({ navigation, route }: Props) {
  const { taskId } = route.params;
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { control, handleSubmit, reset, setValue, watch } = useForm<FormValues>({
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

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getTask(taskId)
      .then((task) => {
        reset({
          title: task.title,
          description: task.description ?? "",
          dueDate: toDateInput(task.dueDate),
          dueTime: task.dueTime ?? "",
          category: task.category ?? "",
          priority: task.priority,
          status: task.status === "DELETED" ? "PENDING" : task.status,
        });
      })
      .catch(() => setError("Could not load task."))
      .finally(() => setLoading(false));
  }, [reset, taskId]);

  useLayoutEffect(() => {
    load();
  }, [load]);

  const onSubmit = handleSubmit(async (values) => {
    setBusy(true);
    setError(null);
    try {
      const dueDate =
        values.dueDate && values.dueDate.trim().length > 0
          ? new Date(`${values.dueDate.trim()}T00:00:00`).toISOString()
          : null;
      await updateTask(taskId, {
        title: values.title.trim(),
        description: values.description?.trim() || null,
        dueDate,
        dueTime: values.dueTime?.trim() || null,
        category: values.category?.trim() || null,
        priority: values.priority,
        status: values.status,
      });
      navigation.pop();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update task.");
    } finally {
      setBusy(false);
    }
  });

  if (loading) {
    return (
      <View style={styles.root}>
        <ScreenHeader title="Edit task" onBack={() => navigation.goBack()} />
        <View style={styles.loadingWrap}>
          <BrandedBootLoader message="Loading task…" />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <ScreenHeader title="Edit task" onBack={() => navigation.goBack()} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={taskFormStyles.scrollContent}
      >
        <View style={taskFormStyles.card}>
          {error ? <Text style={taskFormStyles.error}>{error}</Text> : null}
          <Controller
            control={control}
            name="title"
            render={({ field, fieldState }) => (
              <View style={taskFormStyles.field}>
                <Text style={taskFormStyles.label}>Title</Text>
                <TextInput
                  style={taskFormStyles.input}
                  placeholder="Task title"
                  placeholderTextColor="#94a3b8"
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                />
                {fieldState.error ? (
                  <Text style={taskFormStyles.fieldError}>{fieldState.error.message}</Text>
                ) : null}
              </View>
            )}
          />
          <Controller
            control={control}
            name="description"
            render={({ field }) => (
              <View style={taskFormStyles.field}>
                <Text style={taskFormStyles.label}>Description</Text>
                <TextInput
                  style={taskFormStyles.multilineInput}
                  multiline
                  placeholder="Optional details"
                  placeholderTextColor="#94a3b8"
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                />
              </View>
            )}
          />
          <Controller
            control={control}
            name="dueDate"
            render={({ field }) => (
              <View style={taskFormStyles.field}>
                <Text style={taskFormStyles.label}>Due date</Text>
                <TextInput
                  style={taskFormStyles.input}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor="#94a3b8"
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                />
              </View>
            )}
          />
          <Controller
            control={control}
            name="dueTime"
            render={({ field }) => (
              <View style={taskFormStyles.field}>
                <Text style={taskFormStyles.label}>Due time</Text>
                <TextInput
                  style={taskFormStyles.input}
                  placeholder="e.g. 5:30 PM"
                  placeholderTextColor="#94a3b8"
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                />
              </View>
            )}
          />
          <Controller
            control={control}
            name="category"
            render={({ field }) => (
              <View style={taskFormStyles.field}>
                <Text style={taskFormStyles.label}>Category</Text>
                <TextInput
                  style={taskFormStyles.input}
                  placeholder="Work, Academic…"
                  placeholderTextColor="#94a3b8"
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                />
              </View>
            )}
          />

          <Text style={taskFormStyles.sectionLabel}>Priority</Text>
          <View style={taskFormStyles.chips}>
            {priorities.map((p) => (
              <Pressable
                key={p}
                onPress={() => setValue("priority", p)}
                style={[taskFormStyles.chip, priority === p && taskFormStyles.chipActive]}
              >
                <Text style={[taskFormStyles.chipText, priority === p && taskFormStyles.chipTextActive]}>
                  {p}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={taskFormStyles.sectionLabel}>Status</Text>
          <View style={[taskFormStyles.chips, { marginBottom: 16 }]}>
            {statuses.map((s) => (
              <Pressable
                key={s}
                onPress={() => setValue("status", s)}
                style={[taskFormStyles.chip, status === s && taskFormStyles.chipActive]}
              >
                <Text style={[taskFormStyles.chipText, status === s && taskFormStyles.chipTextActive]}>
                  {s.replace("_", " ")}
                </Text>
              </Pressable>
            ))}
          </View>

          <GradientPrimaryButton
            title="Save changes"
            onPress={() => void onSubmit()}
            loading={busy}
            disabled={busy}
          />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  loadingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
});
