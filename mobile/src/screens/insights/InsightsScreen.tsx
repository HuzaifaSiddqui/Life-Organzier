import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomNav } from "../../components/BottomNav";
import { BarChart, Donut, Heatmap } from "../../components/charts/Charts";
import { Card, Chip, ConfidenceMeter, ProgressBar, SectionTitle, Toast, TutorialTip } from "../../components/ui";
import { colors, palette, radii } from "../../constants/theme";
import { usePreferences } from "../../context/PreferencesContext";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getApiErrorMessage } from "../../services/api";
import { acceptInsight, dismissInsight, exportAnalyticsCsv, getAnalytics, getInsights, type Analytics } from "../../services/insightsApi";
import type { Pattern, Recommendation } from "../../types/models";
import { categoryColor } from "../../utils/priorityColors";

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
  const { categories, isPro } = usePreferences();
  const [range, setRange] = useState<Range>("month");
  const [data, setData] = useState<Analytics | null>(null);
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(
    async (r: Range, refresh = false) => {
      try {
        const [a, i] = await Promise.all([getAnalytics(r), getInsights(refresh)]);
        setData(a);
        setRecs(i.recommendations);
        setPatterns(i.patterns);
        setError(null);
      } catch (e) {
        setError(getApiErrorMessage(e, "Analytics will appear after your tasks sync."));
      } finally {
        setRefreshing(false);
      }
    },
    [],
  );

  useFocusEffect(
    useCallback(() => {
      void load(range);
    }, [load, range]),
  );

  const exportCsv = async () => {
    if (!isPro) {
      setToast("Export is a Pro feature — switch plans in Settings (demo).");
      return;
    }
    try {
      const { csv, filename } = await exportAnalyticsCsv();
      await Share.share({ title: filename, message: csv });
    } catch (e) {
      setToast(getApiErrorMessage(e));
    }
  };

  const t = data?.totals;
  const prev = data?.previous;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 110 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(range, true); }} />}
      >
        <View style={styles.header}>
          <Text style={styles.h1}>Insights</Text>
          <Pressable onPress={() => void exportCsv()}>
            <Text style={styles.link}>{isPro ? "Export CSV" : "Export (Pro)"}</Text>
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
                      <Text style={styles.insightIcon}>{i.tone === "positive" ? "🌟" : i.tone === "warning" ? "⚠️" : "💡"}</Text>
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
              <Card key={r.id} tone="ai" style={{ gap: 8 }}>
                <Text style={styles.body}>{r.text}</Text>
                <ConfidenceMeter value={r.confidence} label={r.confidenceText} />
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Chip small tone="ai" selected label={r.acceptLabel} onPress={async () => {
                    try {
                      setToast(await acceptInsight(r.id));
                      void load(range);
                    } catch (e) {
                      setToast(getApiErrorMessage(e));
                    }
                  }} />
                  <Chip small label="Dismiss" onPress={async () => {
                    await dismissInsight(r.id).catch(() => undefined);
                    void load(range);
                  }} />
                </View>
              </Card>
            ))}
          </>
        ) : null}
      </ScrollView>
      <Toast text={toast} onHide={() => setToast(null)} />
      <View style={[styles.navDock, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <BottomNav active="Insights" onChange={(tab) => navigation.navigate(tab)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  h1: { fontSize: 26, fontWeight: "800", color: colors.text },
  link: { color: palette.ai, fontWeight: "700" },
  meta: { fontSize: 13, color: colors.textMuted },
  body: { fontSize: 14, color: colors.text, lineHeight: 20 },
  metrics: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  metric: {
    width: "31.5%",
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
  },
  metricValue: { fontSize: 22, fontWeight: "800", color: colors.text },
  metricLabel: { fontSize: 12, color: colors.textMuted },
  delta: { fontSize: 11, fontWeight: "700", marginTop: 2 },
  insightRow: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  insightIcon: { fontSize: 16 },
  dismiss: { color: colors.textMuted, fontWeight: "700" },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  navDock: { position: "absolute", left: 0, right: 0, bottom: 0 },
});
