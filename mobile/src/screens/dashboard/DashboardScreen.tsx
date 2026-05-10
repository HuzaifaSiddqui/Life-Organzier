import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomNav } from "../../components/BottomNav";
import { LogoMark } from "../../components/branding/LogoMark";
import { Skeleton } from "../../components/Skeleton";
import { TaskCard } from "../../components/TaskCard";
import { colors, radii, shadow, shadowTile } from "../../constants/theme";
import { useAuth } from "../../context/AuthContext";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getTasks } from "../../services/tasksApi";
import type { Task } from "../../types/models";

type Props = NativeStackScreenProps<MainStackParamList, "Dashboard">;

export function DashboardScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
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

  const openCount = useMemo(() => tasks.filter((t) => t.status !== "COMPLETED").length, [tasks]);
  const preview = tasks.slice(0, 5);

  const firstName =
    dbUser?.displayName?.split(/\s+/)[0] ??
    dbUser?.email?.split("@")[0] ??
    "there";

  const bento = [
    {
      icon: "📋",
      title: "All tasks",
      subtitle: `${openCount} task${openCount === 1 ? "" : "s"}`,
      onPress: () => navigation.navigate("TaskList"),
    },
    {
      icon: "✍️",
      title: "Add manually",
      subtitle: "Quick entry",
      onPress: () => navigation.navigate("AddTask"),
    },
    {
      icon: "💬",
      title: "Chat task",
      subtitle: "Natural language",
      onPress: () => navigation.navigate("ChatTask"),
    },
    {
      icon: "🎤",
      title: "Voice task",
      subtitle: "Speak it",
      onPress: () => navigation.navigate("VoiceTask"),
    },
  ];

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 100 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.hero}>
          <View style={styles.logoRow}>
            <LogoMark size={48} />
          </View>
          <Text style={styles.greeting}>Hello{firstName ? `, ${firstName}` : ""}</Text>
          <Text style={styles.sub}>
            You have {openCount} task{openCount === 1 ? "" : "s"} today
          </Text>

          <View style={styles.grid}>
            {bento.map((tile) => (
              <Pressable
                key={tile.title}
                style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
                onPress={tile.onPress}
              >
                <Text style={styles.tileEmoji}>{tile.icon}</Text>
                <Text style={styles.tileTitle}>{tile.title}</Text>
                <Text style={styles.tileMeta}>{tile.subtitle}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Up next</Text>
          <Pressable onPress={() => navigation.navigate("TaskList")}>
            <Text style={styles.link}>See all</Text>
          </Pressable>
        </View>

        {loading ? (
          <View style={{ marginTop: 8, gap: 10 }}>
            <Skeleton height={88} />
            <Skeleton height={88} />
            <Skeleton height={88} />
          </View>
        ) : error ? (
          <Text style={styles.error}>{error}</Text>
        ) : preview.length === 0 ? (
          <Text style={styles.empty}>No tasks yet. Create one from the shortcuts above.</Text>
        ) : (
          <View>
            {preview.map((item) => (
              <TaskCard
                key={item.id}
                task={item}
                variant="dashboard"
                onPress={() => navigation.navigate("TaskDetail", { taskId: item.id })}
              />
            ))}
          </View>
        )}
      </ScrollView>

      <View style={[styles.navDock, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <BottomNav active="Dashboard" onChange={(tab) => navigation.navigate(tab)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 24,
  },
  navDock: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "transparent",
  },
  hero: {
    borderRadius: radii.xl,
    padding: 24,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    ...shadow,
  },
  logoRow: {
    alignItems: "center",
    marginBottom: 16,
  },
  greeting: {
    fontSize: 22,
    fontWeight: "600",
    textAlign: "center",
    color: colors.text,
    lineHeight: 28,
    marginBottom: 4,
  },
  sub: {
    textAlign: "center",
    color: colors.textMuted,
    fontSize: 15,
    marginBottom: 24,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  tile: {
    width: "47%",
    minHeight: 112,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadowTile,
  },
  tilePressed: {
    transform: [{ scale: 0.98 }],
  },
  tileEmoji: {
    fontSize: 22,
    marginBottom: 8,
  },
  tileTitle: {
    fontWeight: "600",
    color: colors.text,
    marginBottom: 4,
    fontSize: 16,
  },
  tileMeta: {
    fontSize: 14,
    color: colors.textMuted,
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: "600",
    color: colors.text,
  },
  link: {
    color: colors.primary,
    fontWeight: "500",
    fontSize: 14,
  },
  empty: {
    color: colors.textMuted,
    marginTop: 8,
    fontSize: 15,
  },
  error: {
    color: "#b91c1c",
    marginTop: 8,
  },
});
