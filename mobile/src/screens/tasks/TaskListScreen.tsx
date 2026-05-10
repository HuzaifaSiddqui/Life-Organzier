import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { LinearGradient } from "expo-linear-gradient";
import { useCallback, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomNav } from "../../components/BottomNav";
import { Skeleton } from "../../components/Skeleton";
import { TaskCard } from "../../components/TaskCard";
import { colors, radii, shadow } from "../../constants/theme";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getTasks } from "../../services/tasksApi";
import type { Task } from "../../types/models";

type Props = NativeStackScreenProps<MainStackParamList, "TaskList">;

export function TaskListScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
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
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: Math.max(insets.top, 12) }]}>
        <Text style={styles.headerTitle}>Tasks</Text>
        <Pressable
          style={({ pressed }) => [pressed && styles.newPressed]}
          onPress={() => navigation.navigate("AddTask")}
        >
          <LinearGradient
            colors={["#1D99FF", "#47AFFF"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={styles.newBtn}
          >
            <Text style={styles.newBtnText}>+ New</Text>
          </LinearGradient>
        </Pressable>
      </View>

      {loading ? (
        <View style={{ paddingHorizontal: 16, marginTop: 8, gap: 10 }}>
          <Skeleton height={88} />
          <Skeleton height={88} />
          <Skeleton height={88} />
        </View>
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : (
        <FlatList
          style={styles.list}
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 16,
            paddingBottom: insets.bottom + 100,
          }}
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
          renderItem={({ item }) => (
            <TaskCard
              task={item}
              variant="list"
              onPress={() => navigation.navigate("TaskDetail", { taskId: item.id })}
            />
          )}
        />
      )}

      <View style={[styles.navDock, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <BottomNav active="TaskList" onChange={(tab) => navigation.navigate(tab)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 16,
    backgroundColor: colors.bg,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: "600",
    color: colors.text,
  },
  newBtn: {
    height: 44,
    paddingHorizontal: 16,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    ...shadow,
  },
  newBtnText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 15,
  },
  newPressed: {
    opacity: 0.92,
    transform: [{ scale: 0.97 }],
  },
  list: {
    flex: 1,
  },
  empty: {
    textAlign: "center",
    marginTop: 48,
    color: colors.textMuted,
    fontSize: 15,
  },
  error: {
    color: "#b91c1c",
    marginTop: 24,
    textAlign: "center",
    paddingHorizontal: 16,
  },
  navDock: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
});
