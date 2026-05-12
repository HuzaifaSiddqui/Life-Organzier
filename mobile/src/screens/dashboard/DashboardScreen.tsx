import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomNav } from "../../components/BottomNav";
import { LogoFull } from "../../components/branding/LogoFull";
import { Skeleton } from "../../components/Skeleton";
import { TaskCard } from "../../components/TaskCard";
import { colors, radii, shadowTile } from "../../constants/theme";
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
        <View style={styles.topHeader}>
          <View style={styles.logoCenter}>
            <LogoFull width={228} height={86} />
          </View>
          <Text style={styles.greeting}>Hello{firstName ? `, ${firstName}` : ""}</Text>
          <Text style={styles.sub}>
            You have {openCount} task{openCount === 1 ? "" : "s"} today
          </Text>
        </View>

        <View style={styles.bentoWrap}>
          <View style={styles.bentoRow}>
            {bento.slice(0, 2).map((tile) => (
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
          <View style={styles.bentoRow}>
            {bento.slice(2, 4).map((tile) => (
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

        <View style={styles.sectionBlock}>
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
        </View>
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
    paddingHorizontal: 0,
    paddingTop: 8,
    gap: 0,
  },
  navDock: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "transparent",
  },
  topHeader: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    alignItems: "stretch",
    backgroundColor: colors.bg,
  },
  logoCenter: {
    width: "100%",
    alignItems: "center",
  },
  greeting: {
    fontSize: 28,
    fontWeight: "700",
    textAlign: "left",
    color: colors.text,
    lineHeight: 34,
    marginTop: 14,
    marginBottom: 6,
  },
  sub: {
    textAlign: "left",
    color: colors.textMuted,
    fontSize: 17,
    lineHeight: 24,
  },
  bentoWrap: {
    width: "100%",
    paddingHorizontal: 16,
    gap: 12,
    backgroundColor: colors.bg,
  },
  bentoRow: {
    flexDirection: "row",
    gap: 12,
    width: "100%",
  },
  tile: {
    flex: 1,
    minHeight: 132,
    backgroundColor: colors.surface,
    paddingVertical: 20,
    paddingHorizontal: 16,
    justifyContent: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
    ...shadowTile,
  },
  tilePressed: {
    opacity: 0.92,
    backgroundColor: colors.surfaceSoft,
  },
  tileEmoji: {
    fontSize: 28,
    marginBottom: 10,
  },
  tileTitle: {
    fontWeight: "700",
    color: colors.text,
    marginBottom: 6,
    fontSize: 18,
  },
  tileMeta: {
    fontSize: 15,
    color: colors.textMuted,
    lineHeight: 20,
  },
  sectionBlock: {
    marginHorizontal: 16,
    marginTop: 8,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
    gap: 8,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    ...shadowTile,
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
