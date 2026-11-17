import { OutboxRefused, send, type SendInput } from "../../services/outbox";
import { useCacheLoader } from "../../hooks/useCachedQuery";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { AssistantCards } from "../../components/assistant/AssistantCards";
import { CrisisCard } from "../../components/assistant/CrisisCard";
import { useLocale } from "../../i18n/LocaleProvider";
import { useTheme } from "../../theme/ThemeProvider";
import { withAlpha } from "../../theme/tokens";
import { hapticTap } from "../../services/haptics";
import { BarChart } from "../../components/charts/Charts";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Button, Card, Chip, SectionTitle, Snackbar, TutorialTip, ui } from "../../components/ui";
import { colors, palette } from "../../constants/theme";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getApiErrorMessage } from "../../services/api";
import { getMoodHistory, logMood } from "../../services/insightsApi";
import type { ActionPayload, CrisisPayload, Mood, MoodLog, MoodRecommendation } from "../../types/models";

type Props = NativeStackScreenProps<MainStackParamList, "Mood">;

const SCALE = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
const MOODS: Mood[] = ["stressed", "anxious", "overwhelmed", "tired", "sad", "calm", "focused", "motivated", "happy"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function defaultMood(score: number): Mood {
  return score <= 2 ? "overwhelmed" : score <= 4 ? "stressed" : score <= 6 ? "calm" : score <= 8 ? "happy" : "motivated";
}

export function MoodScreen({ navigation }: Props) {
  const [score, setScore] = useState<number | null>(null);
  const [mood, setMood] = useState<Mood | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [rec, setRec] = useState<MoodRecommendation | null>(null);
  const [crisis, setCrisis] = useState<CrisisPayload | null>(null);
  const { t } = useLocale();
  const theme = useTheme();
  const [logs, setLogs] = useState<MoodLog[]>([]);
  const [byWeekday, setByWeekday] = useState<Array<{ weekday: number; count: number; avgScore: number | null }>>([]);
  const [toast, setToast] = useState<string | null>(null);

  const cached = useCacheLoader();
  const load = useCallback(async () => {
    try {
      await cached("mood-history", () => getMoodHistory(30), (r) => {
        setLogs(r.logs);
        setByWeekday(r.byWeekday);
      });
    } catch {
      // offline: the saved history stays on screen
    }
  }, [cached]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const save = async () => {
    if (score === null && !mood) return;
    // Without a note there is nothing to check for a crisis: shown at once, sent now or when back online.
    // With a note the server's crisis check must answer first (CLAUDE.md: safety stays deterministic, server-side).
    if (!note.trim()) {
      const m = mood ?? defaultMood(score ?? 5);
      setLogs((list) => [{ id: `local-${Date.now()}`, mood: m, score, source: "MANUAL", note: null, createdAt: new Date().toISOString() }, ...list]);
      setToast(t("offline.moodSaved"));
      try {
        const r = await send<{ recommendation: MoodRecommendation; crisis: CrisisPayload | null }>({ method: "POST", path: "/mood", body: { mood: m, score: score ?? undefined, source: "MANUAL" }, label: "Mood" });
        if (r) {
          setRec(r.crisis ? null : r.recommendation);
          setCrisis(r.crisis ?? null);
          void load();
        }
      } catch (e) {
        if (!(e instanceof OutboxRefused)) throw e;
        setToast(e.message);
        void load();
      }
      return;
    }
    setBusy(true);
    try {
      const m = mood ?? defaultMood(score ?? 5);
      const r = await logMood({ mood: m, score: score ?? undefined, note: note.trim() || undefined, source: "MANUAL" });
      setRec(r.crisis ? null : r.recommendation);
      setCrisis(r.crisis ?? null);
      setNote("");
      void load();
    } catch (e) {
      setToast(getApiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onAction = (payload: ActionPayload, label: string) => {
    if (payload.type === "open_task" && typeof payload.taskId === "string") navigation.navigate("TaskDetail", { taskId: payload.taskId });
    else navigation.navigate("Assistant", { payload, label, nonce: Date.now() });
  };

  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (13 - i));
    const key = d.toDateString();
    const day = logs.filter((l) => new Date(l.createdAt).toDateString() === key);
    const avg = day.length ? Math.round(day.reduce((s, l) => s + (l.score ?? 5), 0) / day.length) : 0;
    return { label: `${d.getDate()}/${d.getMonth() + 1}`, value: avg };
  });

  return (
    <View style={ui.screen}>
      <ScreenHeader title="How are you?" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
        <TutorialTip id="mood" title="Mood shapes your plan" text="When you're stressed I suggest lighter tasks and breaks; when you're energised I suggest your hardest work." />
        <Card style={{ gap: 12 }}>
          <Text style={ui.h2}>Right now I feel… {score ? `${score}/10` : ""}</Text>
          {/* UI v3: one round button per score, tinted from low (red) to great (green); the chosen one fills. */}
          <View style={styles.scale}>
            {SCALE.map((e, i) => {
              const n = i + 1;
              const tint = n <= 3 ? theme.colors.danger.fg : n <= 6 ? theme.colors.warning.fg : theme.colors.success.fg;
              const on = score === n;
              return (
                <Pressable
                  key={e}
                  onPress={() => {
                    hapticTap();
                    setScore(n);
                  }}
                  hitSlop={4}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={t("mood.score", { score: n })}
                  style={[styles.scaleBtn, { borderColor: tint, backgroundColor: on ? tint : withAlpha(tint, 0.08) }]}
                >
                  <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 14, color: on ? theme.colors.onAccent : tint }}>{e}</Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.scaleEnds}>
            <Text style={styles.scaleNum}>{t("mood.low")}</Text>
            <Text style={styles.scaleNum}>{t("mood.great")}</Text>
          </View>
          <View style={ui.wrap}>
            {MOODS.map((m) => (
              <Chip key={m} small label={m} selected={mood === m} onPress={() => setMood(mood === m ? null : m)} />
            ))}
          </View>
          <TextInput style={ui.input} value={note} onChangeText={setNote} placeholder="Anything on your mind? (optional)" placeholderTextColor={palette.muted} />
          <Button title="Log mood" kind="tonal" onPress={() => void save()} loading={busy} disabled={score === null && !mood} />
        </Card>

        {crisis ? (
          <>
            <Card style={{ gap: 10 }}>
              <Text style={ui.body}>{crisis.message}</Text>
            </Card>
            <CrisisCard resources={crisis.resources} onClearTasks={() => onAction({ type: "postpone_nonurgent" }, t("crisis.clearTasks"))} />
          </>
        ) : null}

        {rec ? (
          <Card tone="accent" style={{ gap: 10 }}>
            <Text style={ui.body}>{rec.message}</Text>
            <AssistantCards cards={[{ type: "mood_support", recommendation: rec }]} onOpenTask={(id) => navigation.navigate("TaskDetail", { taskId: id })} onAction={onAction} />
            <Button title="Talk it through with the assistant" kind="secondary" onPress={() => navigation.navigate("Assistant", { prefill: "Can we talk about how I'm feeling?", autoSend: true, nonce: Date.now() })} />
          </Card>
        ) : null}

        <SectionTitle title="Last 14 days" />
        <Card>
          <BarChart data={days} unit="/10 average" />
        </Card>

        {byWeekday.some((d) => d.count) ? (
          <>
            <SectionTitle title="By day of week" />
            <Card style={{ gap: 6 }}>
              {byWeekday.map((d) => (
                <View key={d.weekday} style={styles.dayRow}>
                  <Text style={styles.dayLabel}>{DAYS[d.weekday]}</Text>
                  <View style={styles.dayTrack}>
                    <View style={[styles.dayFill, { width: `${((d.avgScore ?? 0) / 10) * 100}%`, backgroundColor: (d.avgScore ?? 10) < 5 ? palette.warning : palette.ai }]} />
                  </View>
                  <Text style={styles.dayValue}>{d.avgScore ?? "—"}</Text>
                </View>
              ))}
              <Text style={styles.meta}>After a few weeks I'll notice patterns like "Mondays are hard" and plan lighter days for you.</Text>
            </Card>
          </>
        ) : null}

        {logs.length ? (
          <>
            <SectionTitle title="Recent check-ins" />
            {logs
              .slice(-6)
              .reverse()
              .map((l) => (
                <Card key={l.id} style={{ gap: 2 }}>
                  <Text style={ui.body}>
                    {l.mood} {l.score ? `· ${l.score}/10` : ""}
                  </Text>
                  <Text style={styles.meta}>
                    {new Date(l.createdAt).toLocaleString()} · {l.source.toLowerCase()}
                    {l.note ? ` · “${l.note}”` : ""}
                  </Text>
                </Card>
              ))}
          </>
        ) : null}
      </ScrollView>
      <Snackbar text={toast} onHide={() => setToast(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  scale: { flexDirection: "row", justifyContent: "space-between" },
  scaleBtn: { alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: 14, borderWidth: 1.5 },
  scaleEnds: { flexDirection: "row", justifyContent: "space-between", marginTop: -4 },
  scaleActive: { backgroundColor: palette.aiSoft },
  scaleNum: { fontFamily: "Inter_400Regular", fontSize: 10, color: colors.textMuted },
  meta: { fontFamily: "Inter_400Regular", fontSize: 12, color: colors.textMuted },
  dayRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dayLabel: { width: 34, fontFamily: "Inter_400Regular", fontSize: 12, color: colors.textMuted },
  dayTrack: { flex: 1, height: 8, backgroundColor: colors.border, borderRadius: 4, overflow: "hidden" },
  dayFill: { height: 8, borderRadius: 4 },
  dayValue: { width: 28, textAlign: "right", fontSize: 12, color: colors.text, fontFamily: "Inter_600SemiBold" },
});
