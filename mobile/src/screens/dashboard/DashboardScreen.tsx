import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { TaskCard } from "../../components/TaskCard";
import { colors, radii, shadow } from "../../constants/theme";
import { useAuth } from "../../context/AuthContext";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getTasks } from "../../services/tasksApi";
import type { Task } from "../../types/models";

type Props = NativeStackScreenProps<MainStackParamList, "Dashboard">;

export function DashboardScreen({ navigation }: Props) {
  const { dbUser } = useAuth();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getTasks()
      .then(setTasks)
      .catch(() => setError("Could not load tasks."))
      .finally(() => setLoading(false));
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const preview = tasks.slice(0, 5);

  return (
    <View style={styles.container}>
      <View style={styles.hero}>
        <Text style={styles.greeting}>
          Hello{dbUser?.displayName ? `, ${dbUser.displayName}` : ""}
        </Text>
        <Text style={styles.sub}>Here is a quick overview of your tasks.</Text>
      </View>

      <View style={styles.grid}>
        <Pressable style={styles.tile} onPress={() => navigation.navigate("TaskList")}>
          <Text style={styles.tileTitle}>All tasks</Text>
          <Text style={styles.tileMeta}>{tasks.length} open items</Text>
        </Pressable>
        <Pressable style={styles.tile} onPress={() => navigation.navigate("AddTask")}>
          <Text style={styles.tileTitle}>Add manually</Text>
          <Text style={styles.tileMeta}>Form entry</Text>
        </Pressable>
        <Pressable style={styles.tile} onPress={() => navigation.navigate("ChatTask")}>
          <Text style={styles.tileTitle}>Chat task</Text>
          <Text style={styles.tileMeta}>Natural language</Text>
        </Pressable>
        <Pressable style={styles.tile} onPress={() => navigation.navigate("VoiceTask")}>
          <Text style={styles.tileTitle}>Voice task</Text>
          <Text style={styles.tileMeta}>Speak or dictate</Text>
        </Pressable>
      </View>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Up next</Text>
        <Pressable onPress={() => navigation.navigate("TaskList")}>
          <Text style={styles.link}>See all</Text>
        </Pressable>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 16 }} />
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : preview.length === 0 ? (
        <Text style={styles.empty}>No tasks yet. Create one from the shortcuts above.</Text>
      ) : (
        <FlatList
          data={preview}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <TaskCard task={item} onPress={() => navigation.navigate("TaskDetail", { taskId: item.id })} />
          )}
          scrollEnabled={false}
        />
      )}

      <View style={styles.footer}>
        <Pressable style={styles.footerBtn} onPress={() => navigation.navigate("Profile")}>
          <Text style={styles.footerText}>Profile & future modules</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    backgroundColor: colors.bg,
  },
  hero: {
    borderRadius: radii.lg,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    ...shadow,
  },
  greeting: {
    fontSize: 22,
    fontWeight: "700",
    color: colors.text,
  },
  sub: {
    marginTop: 4,
    color: colors.textMuted,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 12,
  },
  tile: {
    width: "48%",
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow,
  },
  tileTitle: {
    fontWeight: "600",
    color: colors.text,
    marginBottom: 4,
  },
  tileMeta: {
    fontSize: 13,
    color: colors.textMuted,
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 8,
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: colors.text,
  },
  link: {
    color: colors.primary,
    fontWeight: "500",
  },
  empty: {
    color: colors.textMuted,
    marginTop: 8,
  },
  error: {
    color: "#b91c1c",
    marginTop: 8,
  },
  footer: {
    marginTop: "auto",
    paddingTop: 12,
  },
  footerBtn: {
    paddingVertical: 12,
    alignItems: "center",
  },
  footerText: {
    color: colors.primary,
    fontWeight: "500",
  },
});
