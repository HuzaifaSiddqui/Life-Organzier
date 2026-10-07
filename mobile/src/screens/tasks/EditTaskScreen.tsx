import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { ScreenHeader } from "../../components/ScreenHeader";
import { ui } from "../../components/ui";
import { palette } from "../../constants/theme";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getApiErrorMessage } from "../../services/api";
import { getTask, updateTask } from "../../services/tasksApi";
import { TaskForm, toPayload, valuesFromTask, type TaskFormValues } from "./TaskForm";

type Props = NativeStackScreenProps<MainStackParamList, "EditTask">;

export function EditTaskScreen({ navigation, route }: Props) {
  const { taskId } = route.params;
  const [initial, setInitial] = useState<TaskFormValues | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTask(taskId)
      .then((r) => setInitial(valuesFromTask(r.task)))
      .catch((e) => setError(getApiErrorMessage(e)));
  }, [taskId]);

  return (
    <View style={ui.screen}>
      <ScreenHeader title="Edit task" onBack={() => navigation.goBack()} />
      {error ? (
        <Text style={[ui.error, { padding: 16 }]}>{error}</Text>
      ) : !initial ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={palette.ai} />
      ) : (
        <TaskForm
          initial={initial}
          editing
          submitLabel="Save changes"
          onSubmit={async (values) => {
            const { payload, error: err } = toPayload(values, { allowPast: true });
            if (err) return err;
            try {
              await updateTask(taskId, payload);
              navigation.goBack();
              return null;
            } catch (e) {
              return getApiErrorMessage(e, "Could not save changes.");
            }
          }}
        />
      )}
    </View>
  );
}
