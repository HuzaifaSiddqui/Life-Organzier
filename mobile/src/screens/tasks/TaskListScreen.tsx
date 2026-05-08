import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { TaskCard } from "../../components/TaskCard";
import { colors, radii, shadow } from "../../constants/theme";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getTasks } from "../../services/tasksApi";
import type { Task } from "../../types/models";

type Props = NativeStackScreenProps<MainStackParamList, "TaskList">;

export function TaskListScreen({ navigation }: Props) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await getTasks();
      setTasks(data);
    } catch {
      setError("Could not load tasks.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void load();
    }, [load])
  );

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Text style={styles.toolbarTitle}>All tasks</Text>
        <Pressable style={({ pressed }) => [styles.smallBtn, pressed && styles.smallBtnPressed]} onPress={() => navigation.navigate("AddTask")}>
          <Text style={styles.smallBtnText}>+ New</Text>
        </Pressable>
      </View>
      {loading ? (
        <ActivityIndicator style={{ marginTop: 24 }} />
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : (
        <FlatList
          data={tasks}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                void load();
              }}
            />
          }
          ListEmptyComponent={<Text style={styles.empty}>No tasks yet.</Text>}
          contentContainerStyle={{ paddingBottom: 24 }}
          renderItem={({ item }) => (
            <TaskCard task={item} onPress={() => navigation.navigate("TaskDetail", { taskId: item.id })} />
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  toolbar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  toolbarTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: colors.text,
  },
  smallBtn: {
    backgroundColor: colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radii.pill,
    ...shadow,
  },
  smallBtnText: {
    color: "#fff",
    fontWeight: "600",
  },
  smallBtnPressed: {
    opacity: 0.9,
    transform: [{ scale: 0.985 }],
  },
  empty: {
    textAlign: "center",
    marginTop: 32,
    color: colors.textMuted,
  },
  error: {
    color: "#b91c1c",
    marginTop: 16,
    textAlign: "center",
  },
});
