import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  Animated,
  PanResponder,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomNav } from "../../components/BottomNav";
import { TaskCard } from "../../components/TaskCard";
import { Chip, EmptyState, HelpButton, SyncBadge, Snackbar, TutorialTip } from "../../components/ui";
import { colors, palette, radii } from "../../constants/theme";
import { usePreferences } from "../../context/PreferencesContext";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getApiErrorMessage } from "../../services/api";
import { subscribeTasks } from "../../services/syncEngine";
import { deleteTask, getCachedTasks, getTasks, restoreTask, updateTask } from "../../services/tasksApi";
import type { Task, TaskStatus } from "../../types/models";
import { isOverdue } from "../../utils/format";
import { PRIORITY_RANK } from "../../utils/priorityColors";

type Props = NativeStackScreenProps<MainStackParamList, "TaskList">;

type StatusFilter = "ALL" | "PENDING" | "IN_PROGRESS" | "COMPLETED" | "OVERDUE";
type RangeFilter = "ALL" | "TODAY" | "WEEK" | "MONTH";
type SortKey = "due_asc" | "due_desc" | "priority" | "category" | "created";

const STATUS: Array<{ key: StatusFilter; label: string }> = [
  { key: "ALL", label: "All" },
  { key: "PENDING", label: "Pending" },
  { key: "IN_PROGRESS", label: "In progress" },
  { key: "COMPLETED", label: "Completed" },
  { key: "OVERDUE", label: "Overdue" },
];
const RANGES: Array<{ key: RangeFilter; label: string }> = [
  { key: "ALL", label: "Any time" },
  { key: "TODAY", label: "Today" },
  { key: "WEEK", label: "This week" },
  { key: "MONTH", label: "This month" },
];
const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: "due_asc", label: "Due ↑" },
  { key: "due_desc", label: "Due ↓" },
  { key: "priority", label: "Priority" },
  { key: "category", label: "Category" },
  { key: "created", label: "Newest" },
];

function dueTs(t: Task): number {
  const iso = t.scheduledStart ?? t.dueAt ?? t.dueDate;
  return iso ? Date.parse(iso) : Number.POSITIVE_INFINITY;
}

/** Swipe right → complete, swipe left → postpone a day (FR-TM-003 §5). */
function SwipeRow({ children, onRight, onLeft }: { children: ReactNode; onRight: () => void; onLeft: () => void }) {
  const x = useRef(new Animated.Value(0)).current;
  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 14 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderMove: Animated.event([null, { dx: x }], { useNativeDriver: false }),
      onPanResponderRelease: (_e, g) => {
        if (g.dx > 90) onRight();
        else if (g.dx < -90) onLeft();
        Animated.spring(x, { toValue: 0, useNativeDriver: false }).start();
      },
      onPanResponderTerminate: () => Animated.spring(x, { toValue: 0, useNativeDriver: false }).start(),
    }),
  ).current;
  return (
    <View>
      <View style={styles.swipeBg}>
        <Text style={[styles.swipeText, { color: palette.success }]}>Complete</Text>
        <Text style={[styles.swipeText, { color: palette.warning }]}>Postpone ⏭</Text>
      </View>
      <Animated.View style={{ transform: [{ translateX: x }] }} {...responder.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

export function TaskListScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const { categories, settings } = usePreferences();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>(route.params?.filter === "overdue" ? "OVERDUE" : "ALL");
  const [range, setRange] = useState<RangeFilter>(route.params?.filter === "today" ? "TODAY" : "ALL");
  const [sort, setSort] = useState<SortKey>("due_asc");
  const [cats, setCats] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [tagMode, setTagMode] = useState<"AND" | "OR">("OR");
  const [showFilters, setShowFilters] = useState(false);
  const [useContext, setUseContext] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<{ text: string; undoId?: string } | null>(null);

  const load = useCallback(async (fromServer = true) => {
    try {
      setTasks(fromServer ? await getTasks() : await getCachedTasks());
    } catch (e) {
      setToast({ text: getApiErrorMessage(e) });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load(false).then(() => load(true));
    }, [load]),
  );
  useEffect(() => subscribeTasks(() => void load(false)), [load]);
  useEffect(() => {
    if (route.params?.toast) setToast({ text: route.params.toast });
  }, [route.params?.toast]);

  const allTags = useMemo(() => [...new Set(tasks.flatMap((t) => (Array.isArray(t.tags) ? t.tags : [])))].sort(), [tasks]);
  const childrenOf = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks) if (t.parentTaskId) map.set(t.parentTaskId, [...(map.get(t.parentTaskId) ?? []), t]);
    return map;
  }, [tasks]);

  const filtered = useMemo(() => {
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const end = range === "TODAY" ? startToday + 86400000 : range === "WEEK" ? startToday + 7 * 86400000 : range === "MONTH" ? startToday + 31 * 86400000 : Infinity;
    const q = query.trim().toLowerCase();
    const context = useContext ? settings?.currentContext : null;
    const parentsShown = new Set(tasks.filter((t) => !t.parentTaskId).map((t) => t.id));
    const list = tasks.filter((t) => {
      if (t.status === "DELETED" || t.archived) return false;
      if (t.parentTaskId && parentsShown.has(t.parentTaskId) && !q) return false;
      if (status === "OVERDUE" && !isOverdue(t)) return false;
      if (status !== "ALL" && status !== "OVERDUE" && t.status !== (status as TaskStatus)) return false;
      if (range !== "ALL") {
        const d = dueTs(t);
        if (!(d < end)) return false;
      }
      if (cats.length && !cats.includes(t.category ?? "")) return false;
      if (tags.length) {
        const own = Array.isArray(t.tags) ? t.tags : [];
        if (tagMode === "AND" ? !tags.every((x) => own.includes(x)) : !tags.some((x) => own.includes(x))) return false;
      }
      if (context && t.locationContext && t.locationContext !== context) return false;
      if (q && !`${t.title} ${t.description ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const doneLast = (a: Task, b: Task) => Number(a.status === "COMPLETED") - Number(b.status === "COMPLETED");
    list.sort((a, b) => {
      const d = doneLast(a, b);
      if (d) return d;
      switch (sort) {
        case "due_desc":
          return dueTs(b) - dueTs(a);
        case "priority":
          return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || dueTs(a) - dueTs(b);
        case "category":
          return (a.category ?? "~").localeCompare(b.category ?? "~") || dueTs(a) - dueTs(b);
        case "created":
          return Date.parse(b.createdAt) - Date.parse(a.createdAt);
        default:
          return dueTs(a) - dueTs(b);
      }
    });
    return list;
  }, [tasks, status, range, cats, tags, tagMode, query, sort, useContext, settings?.currentContext]);

  const overdueCount = useMemo(() => tasks.filter((t) => isOverdue(t)).length, [tasks]);

  const complete = async (t: Task) => {
    try {
      await updateTask(t.id, { status: t.status === "COMPLETED" ? "PENDING" : "COMPLETED" });
      setToast({ text: t.status === "COMPLETED" ? `Reopened "${t.title}"` : `Completed "${t.title}"` });
    } catch (e) {
      setToast({ text: getApiErrorMessage(e) });
    }
  };

  const postpone = async (t: Task, days = 1) => {
    const base = t.dueDate ? new Date(t.dueDate) : new Date();
    base.setDate(base.getDate() + days);
    try {
      await updateTask(t.id, {
        dueDate: base.toISOString(),
        scheduledStart: t.scheduledStart ? new Date(Date.parse(t.scheduledStart) + days * 86400000).toISOString() : null,
        scheduledEnd: t.scheduledEnd ? new Date(Date.parse(t.scheduledEnd) + days * 86400000).toISOString() : null,
      });
      setToast({ text: `⏭ Postponed "${t.title}" to ${base.toLocaleDateString(undefined, { weekday: "short" })}` });
    } catch (e) {
      setToast({ text: getApiErrorMessage(e) });
    }
  };

  const confirmDelete = (t: Task) => {
    Alert.alert(`Delete "${t.title}"?`, "You can undo within 1 day.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await deleteTask(t.id);
          setToast({ text: `Deleted "${t.title}"`, undoId: t.id });
        },
      },
    ]);
  };

  const moreOptions = (t: Task) => {
    const options = ["Edit", "Reschedule to tomorrow", t.status === "COMPLETED" ? "Archive" : "Ask assistant to plan it", "Delete", "Cancel"];
    const handle = (i: number) => {
      if (i === 0) navigation.navigate("EditTask", { taskId: t.id });
      else if (i === 1) void postpone(t, 1);
      else if (i === 2 && t.status === "COMPLETED") void updateTask(t.id, { archived: true });
      else if (i === 2) navigation.navigate("Assistant", { payload: { type: "suggest_slot", taskId: t.id }, label: `Find time for "${t.title}"`, nonce: Date.now() });
      else if (i === 3) confirmDelete(t);
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions({ options, destructiveButtonIndex: 3, cancelButtonIndex: 4, title: t.title }, handle);
    } else {
      Alert.alert(t.title, undefined, [
        { text: "Edit", onPress: () => handle(0) },
        { text: "Tomorrow", onPress: () => handle(1) },
        { text: t.status === "COMPLETED" ? "Archive" : "Plan it", onPress: () => handle(2) },
        { text: "Delete", style: "destructive", onPress: () => handle(3) },
      ], { cancelable: true });
    }
  };

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const activeFilters = cats.length + tags.length + (range !== "ALL" ? 1 : 0);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.h1}>Tasks</Text>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <HelpButton
            title="Managing tasks"
            text="Swipe right to complete, swipe left to postpone a day, long-press for more options. Filters combine; tags can match all (AND) or any (OR)."
          />
          <Pressable style={styles.addBtn} onPress={() => navigation.navigate("AddTask")}>
            <Text style={styles.addText}>New task</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 120 }]}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(true); }} />}
      >
        <SyncBadge />
        <TutorialTip id="tasks" title="Quick actions" text="Swipe a task right to complete it, left to push it to tomorrow, or long-press for edit/delete." />
        <TextInput style={styles.search} placeholder="Search tasks" placeholderTextColor="#646A78" value={query} onChangeText={setQuery} />

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {STATUS.map((s) => (
            <Chip key={s.key} small label={s.key === "OVERDUE" && overdueCount ? `Overdue (${overdueCount})` : s.label} selected={status === s.key} tone={s.key === "OVERDUE" && overdueCount ? "danger" : undefined} onPress={() => setStatus(s.key)} />
          ))}
        </ScrollView>

        <View style={styles.rowBetween}>
          <Pressable onPress={() => setShowFilters((v) => !v)}>
            <Text style={styles.link}>
              {showFilters ? "Hide filters" : "Filters & sort"}{activeFilters ? ` (${activeFilters})` : ""}
            </Text>
          </Pressable>
          {settings?.currentContext ? (
            <Chip small label={useContext ? settings.currentContext : "All contexts"} selected={useContext} onPress={() => setUseContext((v) => !v)} />
          ) : null}
        </View>

        {showFilters ? (
          <View style={styles.filters}>
            <Text style={styles.label}>Date range</Text>
            <View style={styles.wrap}>
              {RANGES.map((r) => (
                <Chip key={r.key} small label={r.label} selected={range === r.key} onPress={() => setRange(r.key)} />
              ))}
            </View>
            <Text style={styles.label}>Categories</Text>
            <View style={styles.wrap}>
              {categories.map((c) => (
                <Chip key={c.id} small label={c.name} selected={cats.includes(c.name)} onPress={() => setCats((l) => toggle(l, c.name))} />
              ))}
            </View>
            {allTags.length ? (
              <>
                <View style={styles.rowBetween}>
                  <Text style={styles.label}>Tags</Text>
                  <Chip small label={`Match ${tagMode}`} onPress={() => setTagMode((m) => (m === "AND" ? "OR" : "AND"))} />
                </View>
                <View style={styles.wrap}>
                  {allTags.map((t) => (
                    <Chip key={t} small label={`#${t} (${tasks.filter((x) => Array.isArray(x.tags) && x.tags.includes(t)).length})`} selected={tags.includes(t)} onPress={() => setTags((l) => toggle(l, t))} />
                  ))}
                </View>
              </>
            ) : null}
            <Text style={styles.label}>Sort by</Text>
            <View style={styles.wrap}>
              {SORTS.map((s) => (
                <Chip key={s.key} small label={s.label} selected={sort === s.key} onPress={() => setSort(s.key)} />
              ))}
            </View>
          </View>
        ) : null}

        <Text style={styles.count}>
          {status === "OVERDUE" ? `${filtered.length} overdue task${filtered.length === 1 ? "" : "s"}` : `${filtered.length} task${filtered.length === 1 ? "" : "s"}`}
          {tags.length ? ` · ${tags.map((t) => `#${t}`).join(tagMode === "AND" ? " + " : " / ")}` : ""}
        </Text>

        {filtered.length === 0 ? (
          <EmptyState
                        title={query ? "No matching tasks" : "Nothing here"}
            text={query ? "Try another word." : "Tell the assistant what you need to do — it will organise it for you."}
          />
        ) : (
          filtered.map((t) => {
            const kids = (childrenOf.get(t.id) ?? []).filter((k) => k.status !== "DELETED");
            return (
              <View key={t.id}>
                <SwipeRow onRight={() => void complete(t)} onLeft={() => void postpone(t)}>
                  <TaskCard
                    task={t}
                    query={query}
                    categoryColors={categories}
                    onPress={() => navigation.navigate("TaskDetail", { taskId: t.id })}
                    onLongPress={() => moreOptions(t)}
                    subtaskCount={kids.length}
                    expanded={expanded[t.id]}
                    onToggleExpand={() => setExpanded((e) => ({ ...e, [t.id]: !e[t.id] }))}
                  />
                </SwipeRow>
                {expanded[t.id]
                  ? kids.map((k) => (
                      <View key={k.id} style={styles.child}>
                        <TaskCard task={k} variant="compact" onPress={() => navigation.navigate("TaskDetail", { taskId: k.id })} onLongPress={() => moreOptions(k)} />
                      </View>
                    ))
                  : null}
              </View>
            );
          })
        )}
      </ScrollView>

      <Snackbar
        text={toast?.text ?? null}
        onHide={() => setToast(null)}
        action={
          toast?.undoId
            ? {
                label: "Undo",
                onPress: async () => {
                  const id = toast.undoId as string;
                  setToast(null);
                  try {
                    await restoreTask(id);
                    void load(true);
                  } catch (e) {
                    setToast({ text: getApiErrorMessage(e) });
                  }
                },
              }
            : undefined
        }
      />
      <View style={[styles.navDock, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <BottomNav active="TaskList" onChange={(tab) => navigation.navigate(tab)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6 },
  h1: { fontSize: 24, lineHeight: 30, fontFamily: "Inter_700Bold", color: colors.text, letterSpacing: -0.5 },
  addBtn: { backgroundColor: colors.text, borderRadius: radii.pill, paddingHorizontal: 16, paddingVertical: 9 },
  addText: { color: colors.bg, fontFamily: "Inter_500Medium", fontSize: 14 },
  content: { paddingHorizontal: 16, gap: 10 },
  search: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.surface,
    fontSize: 15,
    color: colors.text,
  },
  chips: { gap: 8 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  link: { color: colors.primary, fontFamily: "Inter_600SemiBold" },
  filters: { backgroundColor: colors.surface, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, padding: 12, gap: 8 },
  label: { fontSize: 12, fontFamily: "Inter_500Medium", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.3 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  count: { color: colors.textMuted, fontSize: 13, fontFamily: "Inter_500Medium" },
  child: { marginLeft: 22 },
  swipeBg: {
    ...StyleSheet.absoluteFill,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 18,
    marginBottom: 10,
  },
  swipeText: { fontFamily: "Inter_700Bold" },
  navDock: { position: "absolute", left: 0, right: 0, bottom: 0 },
});
