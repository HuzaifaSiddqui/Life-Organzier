import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import { BottomNav } from "../../components/BottomNav";
import { MicIcon } from "../../components/icons/MicIcon";
import { Button, Card, Chip, Dot, ProgressBar, Skeleton, Snackbar, SyncBadge, Text, TutorialTip } from "../../components/ui";
import { usePreferences } from "../../context/PreferencesContext";
import { auth } from "../../lib/firebase";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getApiErrorMessage } from "../../services/api";
import { getBriefing, sendToAssistant } from "../../services/assistantApi";
import { acceptInsight, dismissInsight, logMood } from "../../services/insightsApi";
import { updateRoutineOccurrence } from "../../services/routinesApi";
import { subscribeTasks } from "../../services/syncEngine";
import { useTheme } from "../../theme/ThemeProvider";
import type { ActionPayload, AttentionItem, Briefing, Mood, QuickAction, Task } from "../../types/models";
import { formatDuration } from "../../utils/format";

type Props = NativeStackScreenProps<MainStackParamList, "Dashboard">;

const MOODS: Array<{ mood: Mood; label: string; score: number }> = [
  { mood: "calm", label: "Calm", score: 7 },
  { mood: "motivated", label: "Motivated", score: 8 },
  { mood: "happy", label: "Good", score: 8 },
  { mood: "tired", label: "Tired", score: 4 },
  { mood: "stressed", label: "Stressed", score: 3 },
  { mood: "sad", label: "Low", score: 3 },
  { mood: "overwhelmed", label: "Overwhelmed", score: 2 },
];

function Icon({ d, size = 18, color }: { d: string; size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d={d} stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

const ICON = {
  ask: "M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4 4v-4h0A2 2 0 0 1 4 14V6.5Z",
  chevron: "M9 6l6 6-6 6",
  check: "M5 12.5l4.5 4.5L19 7.5",
  repeat: "M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4",
  doc: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5ZM14 3v5h5M9 13h6M9 17h4",
  pulse: "M3 12h4l3-8 4 16 3-8h4",
  memory: "M12 3a6 6 0 0 0-6 6c0 2.2 1.2 3.6 2 4.5.6.7 1 1.5 1 2.5v1h6v-1c0-1 .4-1.8 1-2.5.8-.9 2-2.3 2-4.5a6 6 0 0 0-6-6ZM9.5 21h5",
};

function greetingFor(b: Briefing | null): string {
  const h = new Date().getHours();
  const part = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  const name = auth.currentUser?.displayName?.trim().split(/\s+/)[0] ?? b?.greeting.split(",")[1]?.trim();
  return name ? `${part}, ${name}` : part;
}

export function DashboardScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { colors, spacing, radii } = useTheme();
  const { settings, update } = usePreferences();
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [aiOnline, setAiOnline] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const onboardingChecked = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await getBriefing();
      setBriefing(res.briefing);
      setAiOnline(res.ai.available);
      setError(null);
    } catch (e) {
      setError(getApiErrorMessage(e, "Couldn't load your day."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load(true);
    }, [load]),
  );

  useEffect(() => subscribeTasks(() => void load(true)), [load]);

  // First-run onboarding (FR-OB-001).
  useEffect(() => {
    if (!settings || onboardingChecked.current) return;
    onboardingChecked.current = true;
    if (!settings.onboardingCompleted) navigation.navigate("Onboarding");
  }, [settings, navigation]);

  /** Runs an assistant action inline; anything conversational opens the assistant. */
  const runAction = useCallback(
    async (action: QuickAction, itemId?: string) => {
      const payload = action.payload;
      if (!payload) {
        if (action.text) navigation.navigate("Assistant", { prefill: action.text, autoSend: true, nonce: Date.now() });
        return;
      }
      if (payload.type === "navigate" && typeof payload.screen === "string") {
        navigation.navigate(payload.screen as never);
        return;
      }
      if (payload.type === "open_task" && typeof payload.taskId === "string") {
        navigation.navigate("TaskDetail", { taskId: payload.taskId });
        return;
      }
      if (payload.type === "plan_day" || payload.type === "show_top3" || payload.type === "breathing") {
        navigation.navigate("Assistant", { payload, label: action.label, nonce: Date.now() });
        return;
      }
      setBusyAction(itemId ?? action.label);
      try {
        const reply = await sendToAssistant({ payload: payload as ActionPayload, label: action.label });
        setToast(reply.message.content.split("\n")[0]);
        if (reply.message.actions?.length && reply.message.intent !== "task_created") {
          navigation.navigate("Assistant");
        }
        await load(true);
      } catch (e) {
        setToast(getApiErrorMessage(e));
      } finally {
        setBusyAction(null);
      }
    },
    [load, navigation],
  );

  const checkIn = async (m: (typeof MOODS)[number]) => {
    setBusyAction(`mood-${m.mood}`);
    try {
      const res = await logMood({ mood: m.mood, score: m.score, source: "CHECKIN" });
      setToast(res.recommendation.message);
      if (["stressed", "overwhelmed", "sad", "anxious"].includes(m.mood)) {
        navigation.navigate("Assistant", { payload: { type: "log_mood", mood: m.mood, score: m.score }, label: `I'm feeling ${m.label.toLowerCase()}`, nonce: Date.now() });
      }
      await load(true);
    } catch (e) {
      setToast(getApiErrorMessage(e));
    } finally {
      setBusyAction(null);
    }
  };

  const switchContext = async (ctx: string | null) => {
    await update({ currentContext: ctx });
    await load(true);
  };

  const completeRoutine = async (id: string) => {
    try {
      await updateRoutineOccurrence(id, "COMPLETED");
      void load(true);
    } catch (e) {
      setToast(getApiErrorMessage(e));
    }
  };

  const b = briefing;
  const loadPct = b ? Math.min(100, Math.round((b.today.loadMinutes / Math.max(1, b.today.capacityMinutes)) * 100)) : 0;
  const dateLine = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }).toUpperCase();
  const severityColor = (s: AttentionItem["severity"]) => (s === "critical" ? colors.danger.fg : s === "warning" ? colors.warning.fg : colors.info.fg);
  const taskMeta = (t: Task) => [t.dueTime, t.category].filter(Boolean).join(" · ");

  const sectionHeader = (title: string, right?: React.ReactNode) => (
    <View style={styles.sectionHeader}>
      <Text variant="label" color="tertiary" accessibilityRole="header">
        {title.toUpperCase()}
      </Text>
      {right}
    </View>
  );

  const divider = <View style={[styles.divider, { backgroundColor: colors.hairline }]} />;

  return (
    <View style={[styles.root, { paddingTop: insets.top, backgroundColor: colors.canvas }]}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 110, gap: spacing.xl }]}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.textTertiary} onRefresh={() => { setRefreshing(true); void load(true); }} />}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={{ gap: spacing.xs }}>
          <View style={styles.row}>
            <Text variant="label" color="tertiary" style={styles.flex}>
              {dateLine}
            </Text>
            <SyncBadge />
          </View>
          <Text variant="title1">{greetingFor(b)}</Text>
          {b?.headline || loading ? (
            <Text variant="callout" color="secondary">
              {b?.headline ?? "Preparing your day…"}
            </Text>
          ) : null}
          {!aiOnline ? (
            <Text variant="caption" color="warning">
              Assistant is running in offline mode.
            </Text>
          ) : null}
        </View>

        {/* Ask */}
        <View style={{ gap: spacing.md }}>
          <Pressable
            onPress={() => navigation.navigate("Assistant")}
            accessibilityRole="button"
            accessibilityLabel="Ask the assistant or add a task"
            style={({ pressed }) => [styles.ask, { backgroundColor: colors.surface, borderColor: colors.hairline, borderRadius: radii.md }, pressed && { backgroundColor: colors.accentSoft }]}
          >
            <Icon d={ICON.ask} color={colors.textTertiary} />
            <Text variant="body" color="tertiary" style={styles.flex}>
              Ask anything or add a task
            </Text>
            <Pressable
              onPress={() => navigation.navigate("Assistant", { voice: true, nonce: Date.now() })}
              accessibilityRole="button"
              accessibilityLabel="Speak to the assistant"
              hitSlop={8}
              style={[styles.mic, { backgroundColor: colors.text }]}
            >
              <MicIcon size={16} color={colors.canvas} />
            </Pressable>
          </Pressable>

          {b && b.contexts.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              <Chip small label="Anywhere" selected={!b.context} onPress={() => void switchContext(null)} />
              {b.contexts.map((c) => (
                <Chip key={c} small label={c.replace(/^At\s+/i, "")} selected={b.context === c} onPress={() => void switchContext(c)} />
              ))}
            </ScrollView>
          ) : null}
        </View>

        <TutorialTip id="home" title="Your day at a glance" text="Items that need a decision come first, then your next task and today's plan. Tap the bar above to talk to the assistant." />

        {loading && !b ? (
          <View style={{ gap: spacing.md }}>
            <Skeleton height={88} radius={radii.md} />
            <Skeleton height={160} radius={radii.md} />
          </View>
        ) : error && !b ? (
          <Card>
            <Text variant="body">{error}</Text>
            <Button title="Try again" kind="secondary" size="sm" onPress={() => void load()} style={{ marginTop: spacing.md, alignSelf: "flex-start" }} />
          </Card>
        ) : b ? (
          <>
            {/* Summary */}
            <Card style={{ gap: spacing.lg }}>
              <View style={styles.row}>
                {[
                  { label: "Due today", value: b.stats.dueToday },
                  { label: "Overdue", value: b.stats.overdue, tone: b.stats.overdue ? colors.danger.fg : undefined },
                  { label: "Done", value: b.stats.completedToday },
                ].map((s, i) => (
                  <Fragment key={s.label}>
                    {i > 0 ? <View style={[styles.vRule, { backgroundColor: colors.hairline }]} /> : null}
                    <View style={styles.stat}>
                      <Text variant="title1" tabular style={s.tone ? { color: s.tone } : undefined}>
                        {s.value}
                      </Text>
                      <Text variant="caption" color="secondary">
                        {s.label}
                      </Text>
                    </View>
                  </Fragment>
                ))}
              </View>
              <View style={{ gap: spacing.sm }}>
                <View style={styles.row}>
                  <Text variant="caption" color="secondary" style={styles.flex}>
                    Workload
                  </Text>
                  <Text variant="caption" color="secondary" tabular>
                    {formatDuration(b.today.loadMinutes) || "0 min"} / {formatDuration(b.today.capacityMinutes)}
                  </Text>
                </View>
                <ProgressBar value={loadPct} height={4} color={loadPct > 100 ? colors.danger.fg : loadPct > 80 ? colors.warning.fg : colors.text} accessibilityLabel="Workload today" />
              </View>
            </Card>

            {/* Needs attention */}
            {b.attention.length ? (
              <View>
                {sectionHeader("Needs attention")}
                <Card style={styles.listCard}>
                  {b.attention.map((item, i) => (
                    <View key={item.id}>
                      {i > 0 ? divider : null}
                      <View style={[styles.attention, { padding: spacing.lg, gap: spacing.md }]}>
                        <View style={styles.row}>
                          <View style={styles.dotWrap}>
                            <Dot color={severityColor(item.severity)} />
                          </View>
                          <Text variant="callout" style={styles.flex}>
                            {item.message}
                          </Text>
                        </View>
                        {item.actions.length ? (
                          <View style={[styles.actions, { paddingLeft: 20 }]}>
                            {item.actions.map((a) => (
                              <Button
                                key={a.label}
                                title={a.label}
                                size="sm"
                                kind={a.style === "primary" ? "secondary" : "ghost"}
                                loading={busyAction === item.id && a.style === "primary"}
                                disabled={Boolean(busyAction)}
                                onPress={() => void runAction(a, item.id)}
                              />
                            ))}
                          </View>
                        ) : null}
                      </View>
                    </View>
                  ))}
                </Card>
              </View>
            ) : null}

            {/* Up next */}
            {b.nextUp ? (
              <View>
                {sectionHeader("Up next", b.peak.learned ? <Text variant="caption" color="tertiary">Focus peak {b.peak.label}</Text> : undefined)}
                <Card onPress={() => navigation.navigate("TaskDetail", { taskId: b.nextUp!.id })} accessibilityLabel={`Next task: ${b.nextUp.title}`} style={{ gap: spacing.lg }}>
                  <View style={{ gap: spacing.xs }}>
                    <View style={styles.row}>
                      <Dot color={colors.priority[b.nextUp.priority]} />
                      <Text variant="caption" color="secondary" style={{ marginLeft: spacing.sm }}>
                        {b.nextUp.priority.charAt(0) + b.nextUp.priority.slice(1).toLowerCase()} priority
                        {b.nextUp.isOverdue ? " · Overdue" : ""}
                      </Text>
                    </View>
                    <Text variant="headline">{b.nextUp.title}</Text>
                    {taskMeta(b.nextUp) ? (
                      <Text variant="callout" color="secondary">
                        {taskMeta(b.nextUp)}
                      </Text>
                    ) : null}
                  </View>
                  <View style={styles.actions}>
                    <Button title="Start" size="sm" onPress={() => void runAction({ label: "Start", payload: { type: "start_task", taskId: b.nextUp!.id } })} />
                    <Button title="Mark done" size="sm" kind="ghost" onPress={() => void runAction({ label: "Done", payload: { type: "complete_task", taskId: b.nextUp!.id } })} />
                  </View>
                </Card>
              </View>
            ) : null}

            {/* Today */}
            <View>
              {sectionHeader(
                "Today",
                <Pressable onPress={() => navigation.navigate("Assistant", { payload: { type: "plan_day" }, label: "Plan my day", nonce: Date.now() })} hitSlop={8} accessibilityRole="button">
                  <Text variant="label" color="accent">
                    Plan my day
                  </Text>
                </Pressable>,
              )}
              <Card style={styles.listCard}>
                {b.today.routines.map((r, i) => {
                  const done = r.status === "COMPLETED";
                  const missed = r.status === "MISSED";
                  return (
                    <View key={r.id}>
                      {i > 0 ? divider : null}
                      <View style={[styles.item, { paddingHorizontal: spacing.lg }]}>
                        <Pressable
                          onPress={() => r.status === "PENDING" && void completeRoutine(r.id)}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: done }}
                          accessibilityLabel={`Complete ${r.title}`}
                          hitSlop={10}
                          style={[styles.check, { borderColor: done ? colors.text : colors.textTertiary }, done && { backgroundColor: colors.text }]}
                        >
                          {done ? <Icon d={ICON.check} size={13} color={colors.canvas} /> : null}
                        </Pressable>
                        <View style={styles.flex}>
                          <Text variant="body" color={done || missed ? "tertiary" : "primary"} numberOfLines={1} style={done ? styles.struck : undefined}>
                            {r.title}
                          </Text>
                          <Text variant="caption" color="tertiary">
                            {r.priority === "MANDATORY" ? "Mandatory routine" : "Routine"}
                            {missed ? " · Missed" : ""}
                          </Text>
                        </View>
                        <Text variant="caption" color="secondary" tabular>
                          {r.time ?? "Anytime"}
                        </Text>
                      </View>
                    </View>
                  );
                })}
                {b.today.tasks.slice(0, 6).map((t, i) => (
                  <View key={t.id}>
                    {i > 0 || b.today.routines.length ? divider : null}
                    <Pressable
                      onPress={() => navigation.navigate("TaskDetail", { taskId: t.id })}
                      accessibilityRole="button"
                      style={({ pressed }) => [styles.item, { paddingHorizontal: spacing.lg }, pressed && { backgroundColor: colors.accentSoft }]}
                    >
                      <View style={styles.dotWrap}>
                        <Dot color={colors.priority[t.priority]} />
                      </View>
                      <View style={styles.flex}>
                        <Text variant="body" numberOfLines={1}>
                          {t.title}
                        </Text>
                        <Text variant="caption" color={t.isOverdue ? "danger" : "tertiary"}>
                          {t.isOverdue ? "Overdue" : t.category ?? "Task"}
                        </Text>
                      </View>
                      <Text variant="caption" color="secondary" tabular>
                        {t.dueTime ?? ""}
                      </Text>
                    </Pressable>
                  </View>
                ))}
                {!b.today.tasks.length && !b.today.routines.length ? (
                  <View style={{ padding: spacing.lg }}>
                    <Text variant="callout" color="secondary">
                      Nothing scheduled for today.
                    </Text>
                  </View>
                ) : null}
              </Card>
            </View>

            {/* Mood check-in */}
            {b.mood.checkinDue || !b.mood.latest ? (
              <View>
                {sectionHeader("Check in", <Pressable onPress={() => navigation.navigate("Mood")} hitSlop={8}><Text variant="label" color="accent">More</Text></Pressable>)}
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                  {MOODS.map((m) => (
                    <Chip key={m.mood} label={m.label} onPress={() => !busyAction && void checkIn(m)} />
                  ))}
                </ScrollView>
              </View>
            ) : null}

            {/* Insights */}
            {b.recommendations.length ? (
              <View>
                {sectionHeader("Insights")}
                <Card style={styles.listCard}>
                  {b.recommendations.map((r, i) => (
                    <View key={r.id}>
                      {i > 0 ? divider : null}
                      <View style={{ padding: spacing.lg, gap: spacing.md }}>
                        <Text variant="callout">{r.text}</Text>
                        <View style={styles.row}>
                          <Text variant="caption" color="tertiary" tabular style={styles.flex}>
                            {Math.round(r.confidence * (r.confidence <= 1 ? 100 : 1))}% confidence
                          </Text>
                          <Button
                            title="Not now"
                            size="sm"
                            kind="ghost"
                            onPress={async () => {
                              await dismissInsight(r.id).catch(() => undefined);
                              void load(true);
                            }}
                          />
                          <Button
                            title={r.acceptLabel}
                            size="sm"
                            kind="secondary"
                            loading={busyAction === r.id}
                            onPress={async () => {
                              setBusyAction(r.id);
                              try {
                                setToast(await acceptInsight(r.id));
                                await load(true);
                              } catch (e) {
                                setToast(getApiErrorMessage(e));
                              } finally {
                                setBusyAction(null);
                              }
                            }}
                          />
                        </View>
                      </View>
                    </View>
                  ))}
                </Card>
              </View>
            ) : null}

            {/* Shortcuts */}
            <View>
              {sectionHeader("Organize")}
              <Card style={styles.listCard}>
                {[
                  { icon: ICON.repeat, label: "Routines", go: () => navigation.navigate("Routines") },
                  { icon: ICON.doc, label: "Documents", go: () => navigation.navigate("Documents") },
                  { icon: ICON.pulse, label: "Mood", go: () => navigation.navigate("Mood") },
                  { icon: ICON.memory, label: "What the assistant knows", go: () => navigation.navigate("Memory") },
                ].map((s, i) => (
                  <View key={s.label}>
                    {i > 0 ? divider : null}
                    <Pressable
                      onPress={s.go}
                      accessibilityRole="button"
                      style={({ pressed }) => [styles.item, { paddingHorizontal: spacing.lg }, pressed && { backgroundColor: colors.accentSoft }]}
                    >
                      <Icon d={s.icon} color={colors.textSecondary} />
                      <Text variant="body" style={styles.flex}>
                        {s.label}
                      </Text>
                      <Icon d={ICON.chevron} size={16} color={colors.textTertiary} />
                    </Pressable>
                  </View>
                ))}
              </Card>
            </View>
          </>
        ) : null}
      </ScrollView>

      <Snackbar text={toast} onHide={() => setToast(null)} />
      <View style={[styles.navDock, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <BottomNav active="Dashboard" onChange={(tab) => navigation.navigate(tab)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 16 },
  row: { flexDirection: "row", alignItems: "center" },
  flex: { flex: 1 },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8, minHeight: 20 },
  ask: { flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, paddingLeft: 16, paddingRight: 6, height: 52 },
  mic: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  chips: { gap: 8, paddingRight: 8 },
  stat: { flex: 1, alignItems: "flex-start", gap: 2, paddingLeft: 4 },
  vRule: { width: StyleSheet.hairlineWidth, alignSelf: "stretch", marginHorizontal: 12 },
  listCard: { padding: 0, overflow: "hidden" },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  attention: {},
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  dotWrap: { width: 20, alignItems: "flex-start" },
  item: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingVertical: 10 },
  check: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  struck: { textDecorationLine: "line-through" },
  navDock: { position: "absolute", left: 0, right: 0, bottom: 0 },
});
