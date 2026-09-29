import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { LinearGradient } from "expo-linear-gradient";
import { useCallback, useEffect, useState } from "react";
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

export function TaskListScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: "success" | "warning" } | null>(null);
  const [showMethodPicker, setShowMethodPicker] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await getTasks();
      setTasks(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load tasks.");
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

  useEffect(() => {
    const text = route.params?.toast;
    if (!text) return;
    const tone = route.params?.toastTone ?? "success";
    setToast({ text, tone });
    const id = setTimeout(() => setToast(null), 2800);
    navigation.setParams({ toast: undefined, toastTone: undefined });
    return () => clearTimeout(id);
  }, [navigation, route.params?.toast, route.params?.toastTone]);

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: Math.max(insets.top, 12) }]}>
        <Text style={styles.headerTitle}>Tasks</Text>
        <Pressable
          style={({ pressed }) => [pressed && styles.newPressed]}
          onPress={() => setShowMethodPicker(true)}
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

      {toast ? (
        <View style={[styles.toast, toast.tone === "warning" ? styles.toastWarn : styles.toastOk]}>
          <Text style={styles.toastText}>{toast.text}</Text>
        </View>
      ) : null}
      {showMethodPicker ? (
        <View style={styles.methodCard}>
          <Text style={styles.methodTitle}>How do you want to add a task?</Text>
          <View style={styles.methodActions}>
            <Pressable
              style={styles.methodBtn}
              onPress={() => {
                setShowMethodPicker(false);
                navigation.navigate("AddTask");
              }}
            >
              <Text style={styles.methodBtnText}>Manual</Text>
            </Pressable>
            <Pressable
              style={styles.methodBtn}
              onPress={() => {
                setShowMethodPicker(false);
                navigation.navigate("ChatTask");
              }}
            >
              <Text style={styles.methodBtnText}>Chat</Text>
            </Pressable>
            <Pressable
              style={styles.methodBtn}
              onPress={() => {
                setShowMethodPicker(false);
                navigation.navigate("VoiceTask");
              }}
            >
              <Text style={styles.methodBtnText}>Voice</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

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
  toast: {
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: radii.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
  },
  toastOk: {
    backgroundColor: "#ECFDF3",
    borderColor: "#86EFAC",
  },
  toastWarn: {
    backgroundColor: "#FFFBEB",
    borderColor: "#FCD34D",
  },
  toastText: {
    fontSize: 13,
    color: colors.text,
    fontWeight: "500",
  },
  methodCard: {
    marginHorizontal: 16,
    marginBottom: 10,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
  },
  methodTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
    marginBottom: 10,
  },
  methodActions: {
    flexDirection: "row",
    gap: 8,
  },
  methodBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
  },
  methodBtnText: {
    color: colors.text,
    fontWeight: "600",
    fontSize: 13,
  },
  navDock: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
});
