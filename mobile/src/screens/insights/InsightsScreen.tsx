import { promptUnlock, useFeatureLock } from "../../components/LockedFeature";
import { opacity } from "../../theme/tokens";
import { Icon } from "../../components/icons/Icon";
import { IconButton } from "../../components/primitives";
import { useLocale } from "../../i18n/LocaleProvider";
import { OutboxRefused, send, type SendInput } from "../../services/outbox";
import { useCacheLoader } from "../../hooks/useCachedQuery";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BarChart, Donut, Heatmap } from "../../components/charts/Charts";
import { Card, Chip, ConfidenceMeter, ProgressBar, SectionTitle, Snackbar, TutorialTip } from "../../components/ui";
import { colors, palette, radii } from "../../constants/theme";
import { usePreferences } from "../../context/PreferencesContext";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getApiErrorMessage, isNetworkError } from "../../services/api";
import { exportAnalyticsCsv, getAnalytics, getInsights, type Analytics } from "../../services/insightsApi";
import { shareText } from "../../services/share";
import type { Pattern, Recommendation } from "../../types/models";
import { categoryColor } from "../../utils/priorityColors";
import { useLayout } from "../../theme/useLayout";

type Props = NativeStackScreenProps<MainStackParamList, "Insights">;
type Range = "week" | "month" | "3months" | "all";

const RANGES: Array<{ key: Range; label: string }> = [
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "3months", label: "3 months" },
  { key: "all", label: "All time" },
];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function hourLabel(h: number): string {
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;
}

function Metric({ label, value, delta }: { label: string; value: string; delta?: number | null }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
      {delta !== undefined && delta !== null ? (
        <Text style={[styles.delta, { color: delta >= 0 ? palette.success : palette.danger }]}>
          {delta >= 0 ? "▲" : "▼"} {Math.abs(delta)}% vs last
        </Text>
      ) : null}
    </View>
  );
}

export function InsightsScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { bottomPad } = useLayout();
  const { categories } = usePreferences();
  const lockFor = useFeatureLock();
  const [range, setRange] = useState<Range>("month");
  const [data, setData] = useState<Analytics | null>(null);
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const { t: tr } = useLocale();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const cached = useCacheLoader();
  const load = useCallback(
    async (r: Range, refresh = false) => {
      try {
        // The saved copy of this range shows first (also offline), then the server's.
        await cached(`insights:${r}`, () => Promise.all([getAnalytics(r), getInsights(refresh)]), ([a, i]) => {
          setData(a);
          setRecs(i.recommendations);
          setPatterns(i.patterns);
        });
        setError(null);
      } catch (e) {
        if (!isNetworkError(e)) setError(getApiErrorMessage(e, "Analytics will appear after your tasks sync."));
      } finally {
        setRefreshing(false);
      }
    },
    [cached],
  );

  useFocusEffect(
    useCallback(() => {
      void load(range);
    }, [load, range]),
  );

  // The card goes at once; the choice is sent now or when back online. A refusal brings it back.
  const decide = async (r: Recommendation, choice: "accept" | "dismiss") => {
    setRecs((list) => list.filter((x) => x.id !== r.id));
    try {
      const res = await send<{ message: string }>({ method: "POST", path: `/insights/${encodeURIComponent(r.id)}/${choice}`, key: `insight:${r.id}`, label: "Suggestion" });
      if (res?.message) setToast(res.message);
      else if (!res) setToast(tr("offline.queued"));
      if (res) void load(range);
    } catch (e) {
      if (!(e instanceof OutboxRefused)) throw e;
      setToast(e.message);
      void load(range);
    }
  };

  const exportCsv = async () => {
    const lock = lockFor("analyticsExport");
    if (lock) {
      promptUnlock(lock, tr("lock.name.export"), tr);
      return;
    }
    try {
      const { csv, filename } = await exportAnalyticsCsv();
      await shareText(filename, csv);
    } catch (e) {
      setToast(getApiErrorMessage(e));
    }
  };

  const t = data?.totals;
  const prev = data?.previous;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad(insets.bottom + 110) }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(range, true); }} />}
      >
        <View style={styles.header}>
          {/* Opened from Me (UI v3), so it has a way back. */}
          {navigation.canGoBack() ? (
            <IconButton icon={<Icon name="back" size={22} color={colors.text} />} onPress={() => navigation.goBack()} accessibilityLabel={tr("common.back")} />
          ) : null}
          <Text style={[styles.h1, { flex: 1 }]}>Insights</Text>
          <Pressable onPress={() => void exportCsv()} style={[styles.exportBtn, lockFor("analyticsExport") ? { opacity: opacity.disabled } : null]}>
            {lockFor("analyticsExport") ? <Icon name="lock" size={14} color={palette.ai} /> : null}
            <Text style={styles.link}>Export CSV</Text>
          </Pressable>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {RANGES.map((r) => (
            <Chip key={r.key} small label={r.label} selected={range === r.key} onPress={() => setRange(r.key)} />
          ))}
        </ScrollView>
        <TutorialTip id="insights" title="I learn from your history" text="The more you complete, the more confident I get about your patterns. Recommendations only appear at 50%+ confidence." />

        {error && !data ? <Text style={styles.meta}>{error}</Text> : null}
        {!data && !error ? <ActivityIndicator color={palette.ai} style={{ marginTop: 30 }} /> : null}

        {data && t ? (
          <>
            <View style={styles.metrics}>
              <Metric label="Completion" value={`${t.completionRate}%`} delta={prev ? t.completionRate - prev.completionRate : null} />
              <Metric label="On time" value={t.onTimeRate === null ? "—" : `${t.onTimeRate}%`} />
              <Metric label="Completed" value={`${t.completed}`} />
              <Metric label="Created" value={`${t.created}`} />
              <Metric label="Open" value={`${t.open}`} />
              <Metric label="Overdue" value={`${t.overdue}`} />
            </View>

            {data.insights.filter((i) => !hidden.includes(i.id)).length ? (
              <Card style={{ gap: 8 }}>
                {data.insights
                  .filter((i) => !hidden.includes(i.id))
                  .map((i) => (
                    <View key={i.id} style={styles.insightRow}>
                      <View style={[styles.insightDot, { backgroundColor: i.tone === "positive" ? palette.success : i.tone === "warning" ? palette.warning : palette.info }]} />
                      <Text style={[styles.body, { flex: 1 }]}>{i.text}</Text>
                      <Pressable onPress={() => setHidden((h) => [...h, i.id])} hitSlop={8}>
                        <Text style={styles.dismiss}>✕</Text>
                      </Pressable>
                    </View>
                  ))}
              </Card>
            ) : null}

            <SectionTitle title="Tasks completed" />
            <Card>
              <BarChart data={data.trend.map((p) => ({ label: p.label, value: p.completed }))} unit=" completed" />
            </Card>

            <SectionTitle title="By category" />
            <Card style={{ gap: 12 }}>
              {data.categories.length ? (
                <>
                  <Donut data={data.categories.slice(0, 6).map((c) => ({ label: c.category, value: c.total, color: categoryColor(c.category, categories) }))} />
                  {data.categories.map((c) => (
                    <View key={c.category} style={{ gap: 3 }}>
                      <View style={styles.rowBetween}>
                        <Text style={styles.body}>{c.category}</Text>
                        <Text style={styles.meta}>
                          {c.completed}/{c.total} done · {c.rate}%
                        </Text>
                      </View>
                      <ProgressBar value={c.rate} color={categoryColor(c.category, categories)} height={5} />
                    </View>
                  ))}
                  <Text style={styles.meta}>
                    {data.bestCategory ? `Best: ${data.bestCategory}` : ""}
                    {data.challengingCategory && data.challengingCategory !== data.bestCategory ? ` · Most challenging: ${data.challengingCategory}` : ""}
                  </Text>
                </>
              ) : (
                <Text style={styles.meta}>No tasks in this period.</Text>
              )}
            </Card>

            <SectionTitle title="When you get things done" />
            <Card style={{ gap: 8 }}>
              <Heatmap grid={data.heatmap} />
              <Text style={styles.meta}>
                {data.bestDay !== null ? `Most productive day: ${DAY_NAMES[data.bestDay]}` : "Complete a few tasks to see your rhythm."}
                {data.bestHour !== null ? ` · around ${hourLabel(data.bestHour)}` : ""}
                {data.avgDaysFromDue !== null ? ` · on average ${Math.abs(data.avgDaysFromDue)} day(s) ${data.avgDaysFromDue <= 0 ? "before" : "after"} the deadline` : ""}
              </Text>
            </Card>

            {data.routines.length ? (
              <>
                <SectionTitle title="Routine adherence" />
                <Card style={{ gap: 10 }}>
                  {data.routines.map((r) => (
                    <View key={r.routineId} style={{ gap: 3 }}>
                      <View style={styles.rowBetween}>
                        <Text style={styles.body}>{r.title}</Text>
                        <Text style={styles.meta}>
                          {r.completed}/{r.total} · {r.adherence}%
                        </Text>
                      </View>
                      <ProgressBar value={r.adherence} color={r.adherence >= 80 ? palette.success : r.adherence >= 50 ? palette.warning : palette.danger} height={5} />
                    </View>
                  ))}
                </Card>
              </>
            ) : null}

            {data.avgMood !== null ? <Text style={styles.meta}>Average mood this period: {data.avgMood}/10</Text> : null}
          </>
        ) : null}

        <SectionTitle title="Learned patterns" right={<Pressable onPress={() => navigation.navigate("Memory")}><Text style={styles.link}>What I know →</Text></Pressable>} />
        {patterns.length ? (
          patterns.map((p) => (
            <Card key={p.key} style={{ gap: 8, opacity: p.confidence >= 0.5 ? 1 : 0.6 }}>
              <Text style={styles.body}>{p.description}</Text>
              <ConfidenceMeter value={p.confidence} label={p.confidence >= 0.5 ? `Based on ${p.sampleSize} data points` : `Still observing (${p.sampleSize} data points)`} />
            </Card>
          ))
        ) : (
          <Text style={styles.meta}>No patterns yet — I start learning after a few completed tasks, routines and mood check-ins.</Text>
        )}

        {recs.length ? (
          <>
            <SectionTitle title="Recommendations" />
            {recs.map((r) => (
              <Card key={r.id} tone="accent" style={{ gap: 8 }}>
                <Text style={styles.body}>{r.text}</Text>
                <ConfidenceMeter value={r.confidence} label={r.confidenceText} />
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Chip small tone="accent" selected label={r.acceptLabel} onPress={() => void decide(r, "accept")} />
                  <Chip small label="Dismiss" onPress={() => void decide(r, "dismiss")} />
                </View>
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
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  h1: { fontSize: 26, fontFamily: "Inter_700Bold", color: colors.text },
  link: { color: palette.ai, fontFamily: "Inter_600SemiBold" },
  exportBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  meta: { fontFamily: "Inter_400Regular", fontSize: 13, color: colors.textMuted },
  body: { fontFamily: "Inter_400Regular", fontSize: 14, color: colors.text, lineHeight: 20 },
  metrics: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  metric: {
    width: "31.5%",
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
  },
  metricValue: { fontSize: 22, fontFamily: "Inter_700Bold", color: colors.text },
  metricLabel: { fontFamily: "Inter_400Regular", fontSize: 12, color: colors.textMuted },
  delta: { fontSize: 11, fontFamily: "Inter_600SemiBold", marginTop: 2 },
  insightRow: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  insightDot: { width: 8, height: 8, borderRadius: 4, marginTop: 7 },
  dismiss: { color: colors.textMuted, fontFamily: "Inter_600SemiBold" },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
});
