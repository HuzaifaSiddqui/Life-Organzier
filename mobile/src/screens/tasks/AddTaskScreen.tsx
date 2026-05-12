import { zodResolver } from "@hookform/resolvers/zod";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View, Pressable } from "react-native";
import { TaskFormDueDateRow, TaskFormDueTimeRow } from "../../components/DueDateTimePickers";
import { GradientPrimaryButton } from "../../components/GradientPrimaryButton";
import { ScreenHeader } from "../../components/ScreenHeader";
import { colors } from "../../constants/theme";
import type { MainStackParamList } from "../../navigation/MainStack";
import { createTaskWithReminder } from "../../services/createTaskWithReminder";
import { reminderFeedbackText } from "../../services/reminders";
import type { Priority } from "../../types/models";
import { dueDateAndTimeForSave, validateDueDateNotPast } from "../../utils/datetimeValidation";
import { taskFormStyles } from "./taskFormStyles";
import { z } from "zod";

const priorities: Priority[] = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const statuses = ["PENDING", "IN_PROGRESS", "COMPLETED"] as const;
const quickTimes = ["9:00 AM", "12:00 PM", "3:00 PM", "6:00 PM", "9:00 PM"] as const;

const schema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  dueDate: z.string().optional(),
  dueTime: z.string().optional(),
  reminderEnabled: z.boolean(),
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
      reminderEnabled: true,
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
      const pickedYmd = values.dueDate?.trim() ?? "";
      const { dueDateIso: dueDate, dueTime: dueTimeRaw } = dueDateAndTimeForSave({
        pickerYmd: pickedYmd,
        rawDueTime: values.dueTime,
      });
      if (dueTimeRaw && !dueDate) {
        setError("Couldn't read that due time. Use the picker or a format like 3 PM.");
        return;
      }
      const dateErr = validateDueDateNotPast(dueDate, dueTimeRaw);
      if (dateErr) {
        setError(dateErr);
        return;
      }
      const { reminder } = await createTaskWithReminder(
        {
          title: values.title.trim(),
          description: values.description?.trim() || null,
          dueDate,
          dueTime: dueTimeRaw,
          category: values.category?.trim() || null,
          priority: values.priority,
          status: values.status,
          source: "MANUAL",
        },
        values.reminderEnabled
          ? { reminderEnabled: true, reminderHint: { dueDateIso: dueDate, dueTime: dueTimeRaw } }
          : { reminderEnabled: false },
      );
      navigation.navigate("TaskList", {
        toast: values.reminderEnabled
          ? reminderFeedbackText(reminder)
          : "Reminder disabled for this task",
        toastTone: values.reminderEnabled && reminder.kind === "scheduled" ? "success" : "warning",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save task.");
    } finally {
      setBusy(false);
    }
  });

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 12}
    >
      <ScreenHeader title="New task" onBack={() => navigation.goBack()} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={taskFormStyles.scrollContent}
      >
        <View style={taskFormStyles.card}>
          <Controller
            control={control}
            name="title"
            render={({ field, fieldState }) => (
              <View style={taskFormStyles.field}>
                <Text style={taskFormStyles.label}>Title</Text>
                <TextInput
                  style={taskFormStyles.input}
                  placeholder="What do you need to do?"
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
              <TaskFormDueDateRow
                valueYmd={field.value ?? ""}
                onChangeYmd={field.onChange}
                onClear={() => field.onChange("")}
              />
            )}
          />
          <Controller
            control={control}
            name="dueTime"
            render={({ field }) => (
              <TaskFormDueTimeRow
                valueTime={field.value ?? ""}
                baseYmd={watch("dueDate")?.trim() || undefined}
                onChangeTime={field.onChange}
                quickTimes={quickTimes}
              />
            )}
          />
          <Controller
            control={control}
            name="reminderEnabled"
            render={({ field }) => (
              <View style={styles.reminderRow}>
                <Text style={taskFormStyles.label}>Reminder</Text>
                <Pressable
                  onPress={() => field.onChange(!field.value)}
                  style={[
                    styles.reminderToggle,
                    field.value ? styles.reminderToggleOn : styles.reminderToggleOff,
                  ]}
                >
                  <Text
                    style={[
                      styles.reminderToggleText,
                      field.value ? styles.reminderToggleTextOn : styles.reminderToggleTextOff,
                    ]}
                  >
                    {field.value ? "Enabled" : "Disabled"}
                  </Text>
                </Pressable>
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

          {error ? <Text style={taskFormStyles.error}>{error}</Text> : null}

          <GradientPrimaryButton
            title="Save task"
            onPress={() => void onSubmit()}
            loading={busy}
            disabled={busy}
          />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  reminderRow: {
    marginBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  reminderToggle: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  reminderToggleOn: {
    backgroundColor: "#ECFDF3",
    borderColor: "#86EFAC",
  },
  reminderToggleOff: {
    backgroundColor: "#F8FAFC",
    borderColor: "#CBD5E1",
  },
  reminderToggleText: {
    fontSize: 12,
    fontWeight: "700",
  },
  reminderToggleTextOn: {
    color: "#166534",
  },
  reminderToggleTextOff: {
    color: "#475569",
  },
});
