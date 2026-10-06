import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useMemo } from "react";
import { View } from "react-native";
import { ScreenHeader } from "../../components/ScreenHeader";
import { ui } from "../../components/ui";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getApiErrorMessage } from "../../services/api";
import { createTask } from "../../services/tasksApi";
import { EMPTY_VALUES, TaskForm, toPayload, type TaskFormValues } from "./TaskForm";

type Props = NativeStackScreenProps<MainStackParamList, "AddTask">;

export function AddTaskScreen({ navigation, route }: Props) {
  const prefill = route.params?.prefill;
  const initial = useMemo<TaskFormValues>(
    () => ({
      ...EMPTY_VALUES,
      title: prefill?.title ?? "",
      dueYmd: prefill?.dueYmd ?? "",
      dueTime: prefill?.dueTime ?? "",
      durationMinutes: prefill?.durationMinutes ?? null,
      priority: prefill?.priority ?? "MEDIUM",
      category: prefill?.category ?? null,
      taskType: prefill?.taskType && prefill.taskType !== "ROUTINE" ? prefill.taskType : "FLEXIBLE",
      tags: prefill?.tags ?? [],
    }),
    [prefill],
  );

  return (
    <View style={ui.screen}>
      <ScreenHeader title="New task" onBack={() => navigation.goBack()} />
      <TaskForm
        initial={initial}
        submitLabel="Add task"
        onSubmit={async (values) => {
          const { payload, error } = toPayload(values);
          if (error) return error;
          try {
            const task = await createTask({ ...payload, source: "MANUAL" });
            navigation.replace("TaskList", { toast: task.pendingSync ? "Saved on this phone — it will sync when you're online." : `✓ Added "${task.title}"` });
            return null;
          } catch (e) {
            return getApiErrorMessage(e, "Could not save task.");
          }
        }}
      />
    </View>
  );
}
