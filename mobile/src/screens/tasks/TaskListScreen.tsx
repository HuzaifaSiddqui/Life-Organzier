import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshControl, ScrollView, SectionList, StyleSheet, TextInput, View } from "react-native";
import Animated, { FadeIn, useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FloatingAddButton } from "../../components/FloatingAddButton";
import { Icon } from "../../components/icons/Icon";
import { Button, Chip, EmptyState, IconButton, ListItem, Sheet, Snackbar, SyncBadge, Text } from "../../components/primitives";
import { TaskRow } from "../../components/tasks/TaskRow";
import { usePreferences } from "../../context/PreferencesContext";
import { useLocale } from "../../i18n/LocaleProvider";
import type { StringKey } from "../../i18n/strings";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getApiErrorMessage } from "../../services/api";
import { startTaskNow } from "../../services/assistantApi";
import { cancelSharedTask } from "../../services/collabApi";
import { showAlert } from "../../services/dialog";
import { hapticDone, hapticTap, hapticWarn } from "../../services/haptics";
import { isLocalId, subscribeTasks } from "../../services/syncEngine";
import { deleteTask, getCachedTasks, getTasks, restoreTask, updateTask } from "../../services/tasksApi";
import { useTheme } from "../../theme/ThemeProvider";
import { tabBar } from "../../theme/tokens";
import { useLayout } from "../../theme/useLayout";
import type { Task } from "../../types/models";
import { tasksEmpty } from "../../utils/emptyStates";
import { PRIORITY_RANK } from "../../utils/priorityColors";
import { groupTasks, inView, taskTime, viewCounts, type TaskView } from "../../utils/taskViews";
import { undoStatusChanges } from "../../utils/taskUndo";

type Props = NativeStackScreenProps<MainStackParamList, "TaskList">;
type SortKey = "due_asc" | "due_desc" | "priority" | "category" | "created";

const VIEWS: TaskView[] = ["ALL", "TODAY", "UPCOMING", "NODATE", "OVERDUE", "DONE"];
const SORTS: Array<{ key: SortKey; label: StringKey }> = [
  { key: "due_asc", label: "tasks.sort.due" },
  { key: "due_desc", label: "tasks.sort.dueDesc" },
  { key: "priority", label: "tasks.sort.priority" },
  { key: "category", label: "tasks.sort.category" },
  { key: "created", label: "tasks.sort.created" },
];
const INF = Number.POSITIVE_INFINITY;
const when = (t: Task) => taskTime(t) ?? INF;

/**
 * UI v3 Tasks tab (docs/design.md "Tasks"): everything, dated or not. Smart views with counts (All, Today, Upcoming,
 * No date, Overdue, Done); the list grouped by when (Overdue, Today, Tomorrow, This week, Later, No date); search and
 * a filter sheet (categories, tags all / any, sort, place). Rows: tick = done, swipe right = done, left = tomorrow,
 * hold = actions; every change has Undo.
 */
export function TaskListScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const { bottomPad } = useLayout();
  const { colors, spacing, radii } = useTheme();
  const { t: tr } = useLocale();
  const reduce = useReducedMotion();
  const { categories, settings } = usePreferences();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const searchRef = useRef<TextInput>(null);
  const viewFromParam = (f?: string): TaskView => (f === "overdue" ? "OVERDUE" : f === "today" ? "TODAY" : f === "tomorrow" ? "UPCOMING" : "ALL");
  const [view, setView] = useState<TaskView>(viewFromParam(route.params?.filter));
  const [onlyIds, setOnlyIds] = useState<string[] | null>(route.params?.ids?.length ? route.params.ids : null);
  const [sort, setSort] = useState<SortKey>("due_asc");
  const [cats, setCats] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [tagMode, setTagMode] = useState<"AND" | "OR">("OR");
  const [useContext, setUseContext] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<Task | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<{ text: string; undoId?: string; undoShare?: { id: string; taskId: string | null }; undo?: () => Promise<unknown> } | null>(null);

  useEffect(() => setOnlyIds(route.params?.ids?.length ? route.params.ids : null), [route.params?.ids]);
  // Opened again with a filter (Today's "37 overdue", the evening "See all") while the tab is already alive.
  useEffect(() => {
    if (route.params?.filter) setView(viewFromParam(route.params.filter));
  }, [route.params?.filter]);

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
    if (route.params?.toast) setToast({ text: route.params.toast, undoShare: route.params.undoShare });
  }, [route.params?.toast, route.params?.undoShare]);

  const allTags = useMemo(() => [...new Set(tasks.flatMap((t) => (Array.isArray(t.tags) ? t.tags : [])))].sort(), [tasks]);
  const childrenOf = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks) if (t.parentTaskId && t.status !== "DELETED") map.set(t.parentTaskId, [...(map.get(t.parentTaskId) ?? []), t]);
    return map;
  }, [tasks]);
  const counts = useMemo(() => viewCounts(tasks), [tasks]);
  const catColor = useMemo(() => new Map(categories.map((c) => [c.name, c.color])), [categories]);

  const sorter = useCallback(
    (a: Task, b: Task) => {
      switch (sort) {
        case "due_desc":
          return when(b) - when(a);
        case "priority":
          return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || when(a) - when(b);
        case "category":
          return (a.category ?? "~").localeCompare(b.category ?? "~") || when(a) - when(b);
        case "created":
          return Date.parse(b.createdAt) - Date.parse(a.createdAt);
        default:
          return when(a) - when(b);
      }
    },
    [sort],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const context = useContext ? settings?.currentContext : null;
    const parents = new Set(tasks.filter((t) => !t.parentTaskId).map((t) => t.id));
    return tasks.filter((t) => {
      if (t.status === "DELETED" || t.archived) return false;
      if (onlyIds) return onlyIds.includes(t.id);
      if (t.parentTaskId && parents.has(t.parentTaskId) && !q) return false;
      if (!q && !inView(t, view)) return false;
      if (q && !`${t.title} ${t.description ?? ""} ${(t.tags ?? []).join(" ")}`.toLowerCase().includes(q)) return false;
      if (cats.length && !cats.includes(t.category ?? "")) return false;
      if (tags.length) {
        const own = Array.isArray(t.tags) ? t.tags : [];
        if (tagMode === "AND" ? !tags.every((x) => own.includes(x)) : !tags.some((x) => own.includes(x))) return false;
      }
      if (context && t.locationContext && t.locationContext !== context) return false;
      return true;
    });
  }, [tasks, view, cats, tags, tagMode, query, useContext, settings?.currentContext, onlyIds]);

  const sections = useMemo(() => groupTasks(filtered, new Date(), sorter), [filtered, sorter]);
  const activeFilters = cats.length + tags.length + (sort !== "due_asc" ? 1 : 0);

  const complete = async (t: Task) => {
    try {
      const reopening = t.status === "COMPLETED";
      await updateTask(t.id, { status: reopening ? "PENDING" : "COMPLETED" });
      if (!reopening) hapticDone();
      setToast({ text: tr(reopening ? "tasks.toast.reopened" : "tasks.toast.done", { title: t.title }), undo: () => updateTask(t.id, undoStatusChanges(t)) });
    } catch (e) {
      setToast({ text: getApiErrorMessage(e) });
    }
  };

  const postpone = async (t: Task, days = 1) => {
    const base = t.dueDate ? new Date(t.dueDate) : new Date();
    base.setDate(base.getDate() + days);
    try {
      hapticTap();
      await updateTask(t.id, {
        dueDate: base.toISOString(),
        scheduledStart: t.scheduledStart ? new Date(Date.parse(t.scheduledStart) + days * 86400000).toISOString() : null,
        scheduledEnd: t.scheduledEnd ? new Date(Date.parse(t.scheduledEnd) + days * 86400000).toISOString() : null,
      });
      setToast({
        text: tr("tasks.toast.moved", { title: t.title, day: base.toLocaleDateString(undefined, { weekday: "short" }) }),
        undo: () => updateTask(t.id, { dueDate: t.dueDate ?? null, scheduledStart: t.scheduledStart ?? null, scheduledEnd: t.scheduledEnd ?? null }),
      });
    } catch (e) {
      setToast({ text: getApiErrorMessage(e) });
    }
  };

  const confirmDelete = (t: Task) => {
    setMenuFor(null);
    hapticWarn();
    showAlert(tr("tasks.deleteQ", { title: t.title }), tr("detail.deleteBody"), [
      { text: tr("common.cancel"), style: "cancel" },
      {
        text: tr("detail.delete"),
        style: "destructive",
        onPress: async () => {
          await deleteTask(t.id);
          setToast({ text: tr("tasks.deleted", { title: t.title }), undoId: t.id });
        },
      },
    ]);
  };

  const start = (t: Task) => {
    hapticTap();
    void startTaskNow(t.id).then(
      (text) => setToast({ text: text || tr("tasks.started") }),
      (e) => setToast({ text: getApiErrorMessage(e) }),
    );
  };

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const clearAll = () => {
    setCats([]);
    setTags([]);
    setSort("due_asc");
    setView("ALL");
  };

  const empty = (() => {
    const e = tasksEmpty({ query, filters: cats.length + tags.length, range: view === "TODAY" ? "TODAY" : "ALL", status: view === "OVERDUE" || view === "DONE" ? view : "ALL" });
    const act = {
      clearSearch: { title: tr("empty.clearSearch"), onPress: () => setQuery("") },
      clearFilters: { title: tr("empty.clearFilters"), onPress: clearAll },
      addTask: { title: tr("action.addTask"), onPress: () => navigation.navigate("AddTask") },
      planDay: { title: tr("empty.planDay"), onPress: () => navigation.navigate("Assistant", { payload: { type: "plan_day" }, label: tr("today.planDay"), nonce: Date.now() }) },
      askAssistant: { title: tr("empty.askAssistant"), onPress: () => navigation.navigate("Assistant") },
    } as const;
    return (
      <EmptyState
        icon={<Icon name="tasks" size={32} color={colors.textTertiary} />}
        title={tr(e.title as StringKey)}
        text={tr(e.text as StringKey)}
        action={
          <View style={styles.wrap}>
            {e.actions.map((a, i) => (
              <Button key={a} title={act[a].title} kind={i ? "secondary" : "primary"} size="sm" onPress={act[a].onPress} />
            ))}
          </View>
        }
      />
    );
  })();

  return (
    <View style={[styles.root, { paddingTop: insets.top, backgroundColor: colors.canvas }]}>
      {/* Header: title, search, filters */}
      <View style={[styles.header, { paddingHorizontal: spacing.lg }]}>
        {searching ? (
          <Animated.View entering={reduce ? undefined : FadeIn.duration(150)} style={[styles.search, { backgroundColor: colors.surface, borderColor: colors.hairline, borderRadius: radii.pill }]}>
            <Icon name="search" size={18} color={colors.textTertiary} />
            <TextInput
              ref={searchRef}
              autoFocus
              value={query}
              onChangeText={setQuery}
              placeholder={tr("tasks.search")}
              placeholderTextColor={colors.textTertiary}
              returnKeyType="search"
              style={[styles.flex, styles.searchInput, { color: colors.text }]}
            />
            <IconButton
              icon={<Icon name="close" size={18} color={colors.textSecondary} />}
              onPress={() => {
                setQuery("");
                setSearching(false);
              }}
              accessibilityLabel={tr("tasks.searchClose")}
            />
          </Animated.View>
        ) : (
          <>
            <Text variant="title1" accessibilityRole="header" style={styles.flex}>
              {tr("tasks.title")}
            </Text>
            <SyncBadge />
            <IconButton icon={<Icon name="search" size={22} color={colors.text} />} onPress={() => setSearching(true)} accessibilityLabel={tr("tasks.searchOpen")} />
            <View>
              <IconButton icon={<Icon name="settings" size={22} color={colors.text} />} onPress={() => setFiltersOpen(true)} accessibilityLabel={activeFilters ? tr("tasks.filtersOn", { count: activeFilters }) : tr("tasks.filters")} />
              {activeFilters ? (
                <View pointerEvents="none" style={[styles.badge, { backgroundColor: colors.accent, borderColor: colors.canvas }]}>
                  <Text variant="label" style={{ color: colors.onAccent, fontSize: 10 }}>
                    {activeFilters}
                  </Text>
                </View>
              ) : null}
            </View>
          </>
        )}
      </View>

      {/* Smart views */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.viewsScroll} contentContainerStyle={[styles.views, { paddingHorizontal: spacing.lg }]}>
        {onlyIds ? <Chip selected label={tr("location.onlyTasks", { count: onlyIds.length })} onPress={() => setOnlyIds(null)} /> : null}
        {VIEWS.map((v) => {
          const n = counts[v];
          if (v === "OVERDUE" && !n && view !== "OVERDUE") return null;
          return (
            <Chip
              key={v}
              selected={view === v && !onlyIds && !query}
              tone={v === "OVERDUE" ? "danger" : "accent"}
              label={v === "DONE" ? tr(`tasks.view.${v}` as StringKey) : `${tr(`tasks.view.${v}` as StringKey)} ${n}`}
              onPress={() => {
                hapticTap();
                setOnlyIds(null);
                setView(v);
              }}
            />
          );
        })}
        {settings?.currentContext ? <Chip small label={useContext ? tr("tasks.place", { place: settings.currentContext.replace(/^At\s+/i, "") }) : tr("today.anywhere")} selected={useContext} leading={<Icon name="pin" size={14} color={useContext ? colors.accentStrong : colors.textSecondary} />} onPress={() => setUseContext((x) => !x)} /> : null}
      </ScrollView>

      <SectionList
        sections={filtered.length ? sections.map((s) => ({ key: s.key, data: s.tasks })) : []}
        keyExtractor={(t) => t.id}
        stickySectionHeadersEnabled={false}
        initialNumToRender={12}
        windowSize={7}
        contentContainerStyle={{ paddingBottom: bottomPad(insets.bottom + tabBar.height + 72), paddingTop: spacing.sm }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.textTertiary}
            onRefresh={() => {
              setRefreshing(true);
              void load(true);
            }}
          />
        }
        ListEmptyComponent={<View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.xxl }}>{empty}</View>}
        renderSectionHeader={({ section }) => (
          <View style={[styles.sectionHead, { paddingHorizontal: spacing.lg, paddingTop: spacing.md }]}>
            <Text variant="label" style={{ color: section.key === "overdue" ? colors.danger.fg : colors.textTertiary }} accessibilityRole="header">
              {tr(`tasks.group.${section.key}` as StringKey).toUpperCase()}
            </Text>
            <Text variant="label" color="tertiary" tabular>
              {section.data.length}
            </Text>
          </View>
        )}
        renderItem={({ item: t, index, section }) => {
          const kids = childrenOf.get(t.id) ?? [];
          const first = index === 0;
          const last = index === section.data.length - 1;
          return (
            <View
              style={[
                styles.cell,
                { marginHorizontal: spacing.lg, borderColor: colors.hairline, backgroundColor: colors.surface },
                first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: radii.lg, borderTopRightRadius: radii.lg },
                last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomLeftRadius: radii.lg, borderBottomRightRadius: radii.lg },
              ]}
            >
              {!first ? <View style={[styles.divider, { backgroundColor: colors.hairline }]} /> : null}
              <TaskRow
                task={t}
                query={query}
                categoryColor={t.category ? catColor.get(t.category) : undefined}
                stepCount={kids.length || undefined}
                expanded={expanded[t.id]}
                onToggleExpand={() => setExpanded((e) => ({ ...e, [t.id]: !e[t.id] }))}
                onOpen={() => navigation.navigate("TaskDetail", { taskId: t.id })}
                onToggleDone={() => void complete(t)}
                onTomorrow={() => void postpone(t)}
                onMenu={() => {
                  hapticTap();
                  setMenuFor(t);
                }}
                onStart={isLocalId(t.id) ? undefined : () => start(t)}
              />
              {expanded[t.id]
                ? kids.map((k) => (
                    <TaskRow key={k.id} compact task={k} onOpen={() => navigation.navigate("TaskDetail", { taskId: k.id })} onToggleDone={() => void complete(k)} onTomorrow={() => void postpone(k)} onMenu={() => setMenuFor(k)} />
                  ))
                : null}
            </View>
          );
        }}
      />

      {toast ? null : <FloatingAddButton onPress={() => navigation.navigate("AddTask")} />}
      <Snackbar
        text={toast?.text ?? null}
        onHide={() => setToast(null)}
        action={
          toast?.undo
            ? {
                label: tr("tasks.undo"),
                onPress: async () => {
                  const undo = toast.undo as () => Promise<unknown>;
                  setToast(null);
                  try {
                    await undo();
                    setToast({ text: tr("tasks.toast.undone") });
                  } catch (e) {
                    setToast({ text: getApiErrorMessage(e) });
                  }
                },
              }
            : toast?.undoShare
              ? {
                  label: tr("tasks.undo"),
                  // The same as chat's Undo: cancelled for everyone (cards withdrawn) and my copy removed.
                  onPress: async () => {
                    const s = toast.undoShare as { id: string; taskId: string | null };
                    setToast(null);
                    try {
                      await cancelSharedTask(s.id);
                      if (s.taskId) await deleteTask(s.taskId);
                      setToast({ text: tr("collab.share.undone") });
                      void load(true);
                    } catch (e) {
                      setToast({ text: getApiErrorMessage(e) });
                    }
                  },
                }
              : toast?.undoId
                ? {
                    label: tr("tasks.undo"),
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

      {/* Hold a row: actions */}
      <Sheet visible={Boolean(menuFor)} onClose={() => setMenuFor(null)} title={menuFor?.title}>
        {menuFor ? (
          <>
            <ListItem title={tr(menuFor.status === "COMPLETED" ? "detail.reopen" : "detail.markDone")} leading={<Icon name={menuFor.status === "COMPLETED" ? "undo" : "check"} color={colors.textSecondary} />} onPress={() => { const t = menuFor; setMenuFor(null); void complete(t); }} />
            <ListItem title={tr("action.moveTomorrow")} leading={<Icon name="calendar" color={colors.textSecondary} />} onPress={() => { const t = menuFor; setMenuFor(null); void postpone(t); }} />
            <ListItem title={tr("action.edit")} leading={<Icon name="edit" color={colors.textSecondary} />} onPress={() => { const t = menuFor; setMenuFor(null); navigation.navigate("EditTask", { taskId: t.id }); }} />
            {menuFor.status === "COMPLETED" ? (
              <ListItem title={tr("action.archive")} leading={<Icon name="archive" color={colors.textSecondary} />} onPress={() => { const t = menuFor; setMenuFor(null); void updateTask(t.id, { archived: true }); }} />
            ) : (
              <ListItem title={tr("tasks.menu.findTime")} leading={<Icon name="sparkle" color={colors.textSecondary} />} onPress={() => { const t = menuFor; setMenuFor(null); navigation.navigate("Assistant", { payload: { type: "suggest_slot", taskId: t.id }, label: `Find time for "${t.title}"`, nonce: Date.now() }); }} />
            )}
            <ListItem title={tr("action.delete")} leading={<Icon name="trash" color={colors.danger.fg} />} onPress={() => confirmDelete(menuFor)} />
          </>
        ) : null}
      </Sheet>

      {/* Filters and sort */}
      <Sheet visible={filtersOpen} onClose={() => setFiltersOpen(false)} title={tr("tasks.filters")}>
        <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ gap: spacing.md }}>
          <Text variant="label" color="tertiary">
            {tr("tasks.sort").toUpperCase()}
          </Text>
          <View style={styles.wrap}>
            {SORTS.map((s) => (
              <Chip key={s.key} small label={tr(s.label)} selected={sort === s.key} onPress={() => setSort(s.key)} />
            ))}
          </View>
          {categories.length ? (
            <>
              <Text variant="label" color="tertiary">
                {tr("tasks.categories").toUpperCase()}
              </Text>
              <View style={styles.wrap}>
                {categories.map((c) => (
                  <Chip key={c.id} small label={c.name} leading={<View style={[styles.catDot, { backgroundColor: c.color }]} />} selected={cats.includes(c.name)} onPress={() => setCats((l) => toggle(l, c.name))} />
                ))}
              </View>
            </>
          ) : null}
          {allTags.length ? (
            <>
              <View style={[styles.row, { justifyContent: "space-between" }]}>
                <Text variant="label" color="tertiary">
                  {tr("tasks.tags").toUpperCase()}
                </Text>
                <Chip small label={tr(tagMode === "AND" ? "tasks.matchAll" : "tasks.matchAny")} onPress={() => setTagMode((m) => (m === "AND" ? "OR" : "AND"))} />
              </View>
              <View style={styles.wrap}>
                {allTags.map((x) => (
                  <Chip key={x} small label={`#${x}`} selected={tags.includes(x)} onPress={() => setTags((l) => toggle(l, x))} />
                ))}
              </View>
            </>
          ) : null}
        </ScrollView>
        <View style={[styles.row, { gap: spacing.sm, marginTop: spacing.lg }]}>
          <Button title={tr("tasks.clearAll")} kind="ghost" onPress={clearAll} />
          <Button title={tr("tasks.showResults", { count: filtered.length })} style={styles.flex} onPress={() => setFiltersOpen(false)} />
        </View>
      </Sheet>

    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 56, paddingTop: 4 },
  flex: { flex: 1 },
  row: { flexDirection: "row", alignItems: "center" },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  search: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingStart: 14, borderWidth: 1, minHeight: 48 },
  searchInput: { fontSize: 16, minHeight: 44 },
  badge: { position: "absolute", top: 2, right: 2, minWidth: 18, height: 18, borderRadius: 9, borderWidth: 2, alignItems: "center", justifyContent: "center", paddingHorizontal: 3 },
  viewsScroll: { flexGrow: 0 },
  views: { gap: 8, paddingVertical: 8 },
  sectionHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  cell: { overflow: "hidden", borderLeftWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth },
  divider: { height: StyleSheet.hairlineWidth, marginStart: 56 },
  catDot: { width: 8, height: 8, borderRadius: 4 },
});
