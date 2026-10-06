import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomNav } from "../../components/BottomNav";
import { MicIcon } from "../../components/icons/MicIcon";
import { Skeleton } from "../../components/Skeleton";
import { TaskCard } from "../../components/TaskCard";
import { Button, Card, Chip, ConfidenceMeter, SectionTitle, SyncBadge, Toast, TutorialTip, ProgressBar } from "../../components/ui";
import { colors, palette, radii } from "../../constants/theme";
import { usePreferences } from "../../context/PreferencesContext";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getApiErrorMessage } from "../../services/api";
import { getBriefing, sendToAssistant } from "../../services/assistantApi";
import { acceptInsight, dismissInsight, logMood } from "../../services/insightsApi";
import { updateRoutineOccurrence } from "../../services/routinesApi";
import { subscribeTasks } from "../../services/syncEngine";
import type { ActionPayload, AttentionItem, Briefing, Mood, QuickAction } from "../../types/models";
import { formatDuration } from "../../utils/format";

type Props = NativeStackScreenProps<MainStackParamList, "Dashboard">;

const MOODS: Array<{ mood: Mood; emoji: string; score: number }> = [
  { mood: "happy", emoji: "😊", score: 8 },
  { mood: "motivated", emoji: "💪", score: 8 },
  { mood: "calm", emoji: "😌", score: 7 },
  { mood: "tired", emoji: "😴", score: 4 },
  { mood: "stressed", emoji: "😣", score: 3 },
  { mood: "sad", emoji: "😔", score: 3 },
  { mood: "overwhelmed", emoji: "😵", score: 2 },
];

export function DashboardScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
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
        navigation.navigate("Assistant", { payload: { type: "log_mood", mood: m.mood, score: m.score }, label: `${m.emoji} I'm ${m.mood}`, nonce: Date.now() });
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

  const b = briefing;
  const loadPct = b ? Math.min(100, Math.round((b.today.loadMinutes / Math.max(1, b.today.capacityMinutes)) * 100)) : 0;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 110 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(true); }} />}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.hero}>
          <Text style={styles.greeting}>{b?.greeting ?? "Hello"}</Text>
          <Text style={styles.headline}>{b?.headline ?? (loading ? "Getting your day ready…" : "")}</Text>
          {!aiOnline ? <Text style={styles.aiOff}>AI model offline — I'm using my built-in rules for now.</Text> : null}
          <SyncBadge />
        </View>

        {b && b.contexts.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.contexts}>
            <Chip small label="📍 Anywhere" selected={!b.context} onPress={() => void switchContext(null)} />
            {b.contexts.map((c) => (
              <Chip key={c} small label={c} selected={b.context === c} onPress={() => void switchContext(c)} />
            ))}
          </ScrollView>
        ) : null}

        <Pressable style={styles.ask} onPress={() => navigation.navigate("Assistant")}>
          <Text style={styles.askIcon}>✨</Text>
          <Text style={styles.askText}>Ask or tell me anything…</Text>
          <Pressable onPress={() => navigation.navigate("Assistant", { voice: true, nonce: Date.now() })} style={styles.askMic} hitSlop={8}>
            <MicIcon size={18} color="#fff" />
          </Pressable>
        </Pressable>

        <TutorialTip id="home" title="Your day at a glance" text="I put what needs a decision first, then what to do next. Tap the ✨ bar to talk to me, or the mic to speak." />

        {loading && !b ? (
          <View style={{ gap: 10 }}>
            <Skeleton height={90} />
            <Skeleton height={120} />
          </View>
        ) : error && !b ? (
          <Card tone="danger">
            <Text style={styles.body}>{error}</Text>
            <Button title="Try again" kind="secondary" onPress={() => void load()} style={{ marginTop: 10 }} />
          </Card>
        ) : b ? (
          <>
            {b.mood.checkinDue || !b.mood.latest ? (
              <Card tone="ai" style={{ gap: 10 }}>
                <Text style={styles.cardTitle}>How are you feeling today?</Text>
                <View style={styles.moodRow}>
                  {MOODS.map((m) => (
                    <Pressable key={m.mood} onPress={() => void checkIn(m)} style={styles.moodBtn} disabled={Boolean(busyAction)}>
                      <Text style={{ fontSize: 26 }}>{m.emoji}</Text>
                      <Text style={styles.moodLabel}>{m.mood}</Text>
                    </Pressable>
                  ))}
                </View>
                <Pressable onPress={() => navigation.navigate("Mood")}>
                  <Text style={styles.link}>Use the 1–10 scale or add a note →</Text>
                </Pressable>
              </Card>
            ) : null}

            {b.attention.map((item: AttentionItem) => (
              <Card key={item.id} tone={item.severity === "critical" ? "danger" : item.severity === "warning" ? "warning" : undefined} style={{ gap: 10 }}>
                <Text style={styles.body}>{item.message}</Text>
                {item.actions.length ? (
                  <View style={styles.wrap}>
                    {item.actions.map((a) => (
                      <Chip key={a.label} small label={busyAction === item.id ? "…" : a.label} selected={a.style === "primary"} onPress={() => void runAction(a, item.id)} />
                    ))}
                  </View>
                ) : null}
              </Card>
            ))}

            {b.nextUp ? (
              <View style={{ gap: 6 }}>
                <SectionTitle title="Next best thing" right={<Text style={styles.meta}>{b.peak.learned ? `Peak: ${b.peak.label}` : ""}</Text>} />
                <TaskCard task={b.nextUp} onPress={() => navigation.navigate("TaskDetail", { taskId: b.nextUp!.id })} />
                <View style={styles.wrap}>
                  <Chip small tone="ai" label="▶ Start now" onPress={() => void runAction({ label: "Start", payload: { type: "start_task", taskId: b.nextUp!.id } })} />
                  <Chip small label="✓ Done" onPress={() => void runAction({ label: "Done", payload: { type: "complete_task", taskId: b.nextUp!.id } })} />
                </View>
              </View>
            ) : null}

            <SectionTitle
              title="Today"
              right={
                <Pressable onPress={() => navigation.navigate("Assistant", { payload: { type: "plan_day" }, label: "Plan my day", nonce: Date.now() })}>
                  <Text style={styles.link}>Plan my day ✨</Text>
                </Pressable>
              }
            />
            <Card style={{ gap: 10 }}>
              <View style={{ gap: 4 }}>
                <Text style={styles.meta}>
                  Workload {formatDuration(b.today.loadMinutes) || "0 min"} of {formatDuration(b.today.capacityMinutes)}
                </Text>
                <ProgressBar value={loadPct} color={loadPct > 100 ? palette.danger : loadPct > 80 ? palette.warning : palette.success} />
              </View>
              {b.today.routines.map((r) => (
                <View key={r.id} style={styles.routineRow}>
                  <Pressable
                    onPress={async () => {
                      if (r.status !== "PENDING") return;
                      try {
                        await updateRoutineOccurrence(r.id, "COMPLETED");
                        void load(true);
                      } catch (e) {
                        setToast(getApiErrorMessage(e));
                      }
                    }}
                    style={[styles.check, r.status === "COMPLETED" && styles.checkDone, r.status === "MISSED" && styles.checkMissed]}
                  >
                    <Text style={{ color: "#fff", fontWeight: "800" }}>{r.status === "COMPLETED" ? "✓" : r.status === "MISSED" ? "×" : ""}</Text>
                  </Pressable>
                  <Text style={[styles.routineText, r.status !== "PENDING" && { color: colors.textMuted }]}>
                    {r.priority === "MANDATORY" ? "⭐ " : "🔁 "}
                    {r.title}
                  </Text>
                  <Text style={styles.meta}>{r.time ?? "anytime"}</Text>
                </View>
              ))}
              {b.today.tasks.slice(0, 6).map((t) => (
                <TaskCard key={t.id} task={t} variant="compact" onPress={() => navigation.navigate("TaskDetail", { taskId: t.id })} />
              ))}
              {!b.today.tasks.length && !b.today.routines.length ? <Text style={styles.meta}>Nothing scheduled today. Want me to plan ahead?</Text> : null}
            </Card>

            {b.recommendations.length ? (
              <>
                <SectionTitle title="What I've learned about you" />
                {b.recommendations.map((r) => (
                  <Card key={r.id} style={{ gap: 10 }}>
                    <Text style={styles.body}>{r.text}</Text>
                    <ConfidenceMeter value={r.confidence} label={r.confidenceText} />
                    <View style={styles.wrap}>
                      <Chip
                        small
                        tone="ai"
                        selected
                        label={busyAction === r.id ? "…" : r.acceptLabel}
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
                      <Chip
                        small
                        label="Not now"
                        onPress={async () => {
                          await dismissInsight(r.id).catch(() => undefined);
                          void load(true);
                        }}
                      />
                    </View>
                  </Card>
                ))}
              </>
            ) : null}

            <View style={styles.tiles}>
              {[
                { icon: "🔁", label: "Routines", go: () => navigation.navigate("Routines") },
                { icon: "📄", label: "Documents", go: () => navigation.navigate("Documents") },
                { icon: "🙂", label: "Mood", go: () => navigation.navigate("Mood") },
                { icon: "🧠", label: "What I know", go: () => navigation.navigate("Memory") },
              ].map((t) => (
                <Pressable key={t.label} style={styles.tile} onPress={t.go}>
                  <Text style={{ fontSize: 22 }}>{t.icon}</Text>
                  <Text style={styles.tileText}>{t.label}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.footnote}>
              {b.stats.completedToday} done today · {b.stats.open} open · {b.stats.overdue} overdue
            </Text>
          </>
        ) : null}
        {busyAction && !busyAction.startsWith("mood") ? <ActivityIndicator color={palette.ai} /> : null}
      </ScrollView>

      <Toast text={toast} onHide={() => setToast(null)} />
      <View style={[styles.navDock, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <BottomNav active="Dashboard" onChange={(tab) => navigation.navigate(tab)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 14 },
  hero: { gap: 6, paddingTop: 6 },
  greeting: { fontSize: 26, fontWeight: "800", color: colors.text },
  headline: { fontSize: 16, color: colors.textMuted, lineHeight: 22 },
  aiOff: { fontSize: 12, color: palette.warning },
  contexts: { gap: 8, paddingVertical: 2 },
  ask: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    borderWidth: 1.5,
    borderColor: "#C4B5FD",
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 6,
  },
  askIcon: { fontSize: 18 },
  askText: { flex: 1, color: colors.textMuted, fontSize: 15 },
  askMic: { width: 38, height: 38, borderRadius: 19, backgroundColor: palette.ai, alignItems: "center", justifyContent: "center" },
  cardTitle: { fontSize: 16, fontWeight: "700", color: colors.text },
  body: { fontSize: 15, color: colors.text, lineHeight: 21 },
  meta: { fontSize: 12, color: colors.textMuted },
  link: { color: palette.ai, fontWeight: "700", fontSize: 13 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  moodRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: "space-between" },
  moodBtn: { alignItems: "center", width: 44 },
  moodLabel: { fontSize: 9, color: colors.textMuted },
  routineRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  routineText: { flex: 1, fontSize: 14, color: colors.text, fontWeight: "600" },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: palette.success, alignItems: "center", justifyContent: "center" },
  checkDone: { backgroundColor: palette.success },
  checkMissed: { backgroundColor: palette.muted, borderColor: palette.muted },
  tiles: { flexDirection: "row", gap: 10 },
  tile: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    paddingVertical: 12,
    gap: 4,
  },
  tileText: { fontSize: 11, fontWeight: "700", color: colors.text, textAlign: "center" },
  footnote: { textAlign: "center", color: colors.textMuted, fontSize: 12 },
  navDock: { position: "absolute", left: 0, right: 0, bottom: 0 },
});
