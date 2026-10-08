import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { AssistantCards } from "../../components/assistant/AssistantCards";
import { CrisisCard } from "../../components/assistant/CrisisCard";
import { useLocale } from "../../i18n/LocaleProvider";
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
  const [logs, setLogs] = useState<MoodLog[]>([]);
  const [byWeekday, setByWeekday] = useState<Array<{ weekday: number; count: number; avgScore: number | null }>>([]);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await getMoodHistory(30);
      setLogs(r.logs);
      setByWeekday(r.byWeekday);
    } catch {
      // offline: history just stays empty
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const save = async () => {
    if (score === null && !mood) return;
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
          <View style={styles.scale}>
            {SCALE.map((e, i) => (
              <Pressable key={e} onPress={() => setScore(i + 1)} style={[styles.scaleBtn, score === i + 1 && styles.scaleActive]}>
                <Text style={{ fontFamily: "Inter_400Regular", fontSize: 22 }}>{e}</Text>
                <Text style={styles.scaleNum}>{i + 1}</Text>
              </Pressable>
            ))}
          </View>
          <View style={ui.wrap}>
            {MOODS.map((m) => (
              <Chip key={m} small label={m} selected={mood === m} onPress={() => setMood(mood === m ? null : m)} />
            ))}
          </View>
          <TextInput style={ui.input} value={note} onChangeText={setNote} placeholder="Anything on your mind? (optional)" placeholderTextColor="#646A78" />
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
  scaleBtn: { alignItems: "center", paddingVertical: 4, borderRadius: 10, width: "9.5%" },
  scaleActive: { backgroundColor: palette.aiSoft },
  scaleNum: { fontFamily: "Inter_400Regular", fontSize: 10, color: colors.textMuted },
  meta: { fontFamily: "Inter_400Regular", fontSize: 12, color: colors.textMuted },
  dayRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dayLabel: { width: 34, fontFamily: "Inter_400Regular", fontSize: 12, color: colors.textMuted },
  dayTrack: { flex: 1, height: 8, backgroundColor: colors.border, borderRadius: 4, overflow: "hidden" },
  dayFill: { height: 8, borderRadius: 4 },
  dayValue: { width: 28, textAlign: "right", fontSize: 12, color: colors.text, fontFamily: "Inter_600SemiBold" },
});
