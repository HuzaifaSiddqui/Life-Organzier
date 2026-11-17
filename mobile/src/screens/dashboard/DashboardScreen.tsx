import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { LinearGradient } from "expo-linear-gradient";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeInDown, LinearTransition, useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NotificationBell, SharedWithYouCard } from "../../components/collab/HomeShared";
import { FloatingAddButton } from "../../components/FloatingAddButton";
import { GuestBanner } from "../../components/GuestBanner";
import { Icon } from "../../components/icons/Icon";
import { clockLabel } from "../../components/plan/clock";
import { Button, Card, Chip, Dot, ListItem, PressableScale, Sheet, Skeleton, Snackbar, SyncBadge, Text } from "../../components/primitives";
import { AgendaRow } from "../../components/today/AgendaRow";
import { DayRing } from "../../components/today/DayRing";
import { NudgeCard } from "../../components/today/NudgeCard";
import { TutorialTip } from "../../components/ui";
import { useAuth } from "../../context/AuthContext";
import { usePreferences } from "../../context/PreferencesContext";
import { useDayData } from "../../hooks/useDayData";
import { useLocale } from "../../i18n/LocaleProvider";
import type { StringKey } from "../../i18n/strings";
import { auth } from "../../lib/firebase";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getApiErrorMessage } from "../../services/api";
import { getBriefing, sendToAssistant } from "../../services/assistantApi";
import { hapticDone, hapticTap } from "../../services/haptics";
import { readCache, writeCache } from "../../services/localCache";
import { OutboxRefused, send } from "../../services/outbox";
import { cancelTaskSnooze, scheduleReminderSync, snoozeTaskReminder } from "../../services/reminders";
import { getCachedTasks, setTaskStatus } from "../../services/tasksApi";
import { useTheme } from "../../theme/ThemeProvider";
import { palettes, tabBar, withAlpha } from "../../theme/tokens";
import { useLayout } from "../../theme/useLayout";
import type { ActionPayload, AttentionItem, Briefing, Mood, QuickAction, Task } from "../../types/models";
import { formatDuration, formatTime } from "../../utils/format";
import { isEvening, thenUp, tomorrowPreview } from "../../utils/homeCards";
import { NEXT_UP_SNOOZE_MINUTES } from "../../utils/taskSnooze";
import type { TimelineItem } from "../../utils/timeline";
import { dayPart, firstName, nudgeLook, nudgesFrom, todayAgenda } from "../../utils/today";
import { catchUpQueue } from "../../utils/catchUp";

type Props = NativeStackScreenProps<MainStackParamList, "Dashboard">;

const MOODS: Array<{ mood: Mood; key: StringKey; score: number }> = [
  { mood: "calm", key: "mood.calm", score: 7 },
  { mood: "motivated", key: "mood.motivated", score: 8 },
  { mood: "happy", key: "mood.happy", score: 8 },
  { mood: "tired", key: "mood.tired", score: 4 },
  { mood: "stressed", key: "mood.stressed", score: 3 },
  { mood: "sad", key: "mood.sad", score: 3 },
  { mood: "overwhelmed", key: "mood.overwhelmed", score: 2 },
];

const CACHE_BRIEFING = "briefing";

/**
 * UI v3 Today (docs/design.md "Today"): what now, and what's left today.
 * Header (progress ring, honest counts, place) → Needs you → Next up → today's agenda around "now" → check-in →
 * suggestions → tomorrow (evening). Tasks and routines come from the same store as Plan, so both always agree and the
 * screen opens instantly offline; the briefing (Next up, attention, suggestions, mood) loads behind it.
 */
export function DashboardScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { bottomPad } = useLayout();
  const { colors, spacing, radii } = useTheme();
  const { t } = useLocale();
  const reduce = useReducedMotion();
  const { settings, update } = usePreferences();
  const { dbUser } = useAuth();
  const { tasks, routines, routinesQ, now } = useDayData();
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [aiOnline, setAiOnline] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snack, setSnack] = useState<{ text: string; action?: { label: string; onPress: () => void } } | null>(null);
  const setToast = useCallback((text: string | null) => setSnack(text ? { text } : null), []);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [placeOpen, setPlaceOpen] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const onboardingChecked = useRef(false);
  const [tomorrow, setTomorrow] = useState<Task[]>([]);
  const evening = isEvening(now);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      if (isEvening()) void getCachedTasks().then((all) => setTomorrow(tomorrowPreview(all)), () => undefined);
      const res = await getBriefing();
      setBriefing(res.briefing);
      void writeCache(CACHE_BRIEFING, res.briefing);
      setAiOnline(res.ai.available);
      setError(null);
    } catch (e) {
      setError(getApiErrorMessage(e, "Couldn't load your day."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Yesterday's copy of the day is better than a blank screen: show the saved one, then refresh it.
  useEffect(() => {
    void readCache<Briefing>(CACHE_BRIEFING).then((saved) => {
      if (!saved) return;
      setBriefing((cur) => cur ?? saved);
      setLoading(false);
    });
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load(true);
    }, [load]),
  );

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
        if (reply.message.actions?.length && reply.message.intent !== "task_created") navigation.navigate("Assistant");
        await load(true);
      } catch (e) {
        setToast(getApiErrorMessage(e));
      } finally {
        setBusyAction(null);
      }
    },
    [load, navigation, setToast],
  );

  /** Next up → "Remind in 1 h": a local reminder in an hour (the notification-snooze path), with Undo. */
  const snoozeNext = async (task: Task) => {
    const at = await snoozeTaskReminder(task, NEXT_UP_SNOOZE_MINUTES).catch(() => null);
    if (!at) return setToast(t("home.snoozeFailed"));
    setSnack({
      text: t("home.snoozed", { title: task.title, time: formatTime(at.toISOString()) }),
      action: { label: t("home.undo"), onPress: () => void cancelTaskSnooze(task.id).then(() => setToast(t("home.snoozeUndone"))) },
    });
  };

  // A one-tap check-in has no text to check for a crisis, so it is shown at once and sent now or when back online.
  const checkIn = async (m: (typeof MOODS)[number]) => {
    hapticTap();
    const label = t(m.key);
    setBriefing((prev) => (prev ? { ...prev, mood: { ...prev.mood, latest: { mood: m.mood, score: m.score, at: new Date().toISOString() }, checkinDue: false } } : prev));
    setToast(t("offline.moodSaved"));
    if (["stressed", "overwhelmed", "sad", "anxious"].includes(m.mood)) {
      navigation.navigate("Assistant", { payload: { type: "log_mood", mood: m.mood, score: m.score }, label: `I'm feeling ${label.toLowerCase()}`, nonce: Date.now() });
    }
    try {
      const res = await send<{ recommendation: { message: string } }>({ method: "POST", path: "/mood", body: { mood: m.mood, score: m.score, source: "CHECKIN" }, label: "Mood" });
      if (res) setToast(res.recommendation.message);
      void load(true);
    } catch (e) {
      if (!(e instanceof OutboxRefused)) throw e;
      setToast(e.message);
      void load(true);
    }
  };

  const switchContext = async (ctx: string | null) => {
    setPlaceOpen(false);
    hapticTap();
    await update({ currentContext: ctx });
    void routinesQ.reload();
    await load(true);
  };

  // The suggestion goes at once; the choice is sent now or when back online. A refusal brings it back.
  const decideInsight = async (id: string, choice: "accept" | "dismiss") => {
    setBriefing((prev) => (prev ? { ...prev, recommendations: prev.recommendations.filter((r) => r.id !== id) } : prev));
    try {
      const res = await send<{ message: string }>({ method: "POST", path: `/insights/${encodeURIComponent(id)}/${choice}`, key: `insight:${id}`, label: "Suggestion" });
      if (res?.message) setToast(res.message);
      if (res) void load(true);
    } catch (e) {
      if (!(e instanceof OutboxRefused)) throw e;
      setToast(e.message);
      void load(true);
    }
  };

  /** Tick / untick an agenda item: shown at once, saved behind it (tasks in the phone's store, routines via the outbox). */
  const toggle = async (item: TimelineItem) => {
    const toDone = !item.done;
    if (toDone) hapticDone();
    else hapticTap();
    if (item.kind === "task") {
      await setTaskStatus(item.id, toDone ? "COMPLETED" : "PENDING");
      setSnack({
        text: t(toDone ? "today.doneToast" : "today.undoneToast", { title: item.title }),
        action: { label: t("home.undo"), onPress: () => void setTaskStatus(item.id, toDone ? "PENDING" : "COMPLETED") },
      });
      return;
    }
    const status = toDone ? "COMPLETED" : "PENDING";
    const setStatus = (s: string) => routinesQ.mutate((prev) => (prev ?? []).map((r) => ({ ...r, occurrences: r.occurrences.map((o) => (o.id === item.id ? { ...o, status: s as typeof o.status } : o)) })));
    setStatus(status);
    try {
      const sent = await send({ method: "PATCH", path: `/routines/occurrences/${item.id}`, body: { status, confirmMandatory: false }, key: `occurrence:${item.id}`, label: "Routine" });
      scheduleReminderSync();
      if (sent) void routinesQ.reload();
    } catch (e) {
      if (!(e instanceof OutboxRefused)) throw e;
      setStatus(toDone ? "PENDING" : "COMPLETED");
      setToast(e.message);
    }
  };

  const openItem = (i: TimelineItem) => {
    if (i.kind === "task") navigation.navigate("TaskDetail", { taskId: i.id });
    else navigation.navigate("Routines", { routineId: i.routineId });
  };

  const colorOf = useCallback(
    (i: TimelineItem) => {
      if (i.kind === "routine") return colors.category[1];
      if (!i.category) return colors.accent;
      let h = 0;
      for (const ch of i.category) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return colors.category[h % colors.category.length];
    },
    [colors],
  );

  const agenda = useMemo(() => todayAgenda(tasks, routines, now), [tasks, routines, now]);
  const nudges = useMemo(() => nudgesFrom(briefing?.attention ?? [], dismissed), [briefing?.attention, dismissed]);
  const nudge = nudges[0] ?? null;
  // The Catch up card counts exactly what Catch up will show (overdue now, earlier today included).
  const slipped = useMemo(() => catchUpQueue(tasks, now).length, [tasks, now]);
  const b = briefing;
  const part = dayPart(now);
  const name = firstName(dbUser?.displayName) ?? firstName(auth.currentUser?.displayName);
  const hello = name ? t(`today.helloName.${part}` as StringKey, { name }) : t(`today.hello.${part}` as StringKey);
  const dateLine = now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  const statusLine = agenda.total === 0 ? t("today.free") : agenda.left === 0 ? t("today.allDone") : t("today.left", { left: agenda.left });
  const severityColor = (s: AttentionItem["severity"]) => (s === "critical" ? colors.danger.fg : s === "warning" ? colors.warning.fg : colors.info.fg);
  const place = settings?.currentContext ?? b?.context ?? null;
  const contexts = b?.contexts ?? [];
  const enter = (i: number) => (reduce ? undefined : FadeInDown.delay(40 * i).duration(220));
  const layout = reduce ? undefined : LinearTransition.springify().damping(22);

  const section = (title: string, right?: ReactNode) => (
    <View style={styles.sectionHeader}>
      <Text variant="label" color="tertiary" accessibilityRole="header">
        {title.toUpperCase()}
      </Text>
      {right}
    </View>
  );
  const link = (label: string, onPress: () => void) => (
    <Pressable onPress={onPress} hitSlop={12} accessibilityRole="button">
      <Text variant="label" color="accent">
        {label}
      </Text>
    </Pressable>
  );
  const divider = <View style={[styles.divider, { backgroundColor: colors.hairline }]} />;

  const nowDivider = (
    <View style={styles.nowRow} accessibilityRole="text" accessibilityLabel={`${t("today.now")} ${clockLabel(now.getHours() * 60 + now.getMinutes())}`}>
      <View style={[styles.nowDot, { backgroundColor: colors.danger.fg }]} />
      <Text variant="label" style={{ color: colors.danger.fg }}>
        {t("today.now")} · {clockLabel(now.getHours() * 60 + now.getMinutes())}
      </Text>
      <View style={[styles.nowLine, { backgroundColor: colors.danger.fg }]} />
    </View>
  );

  const checkinCard =
    b && (b.mood.checkinDue || !b.mood.latest) ? (
      <Animated.View entering={enter(4)} layout={layout}>
        <Card style={{ gap: spacing.md }}>
          <View style={styles.row}>
            <Icon name="pulse" size={18} color={colors.accentStrong} />
            <Text variant="bodyStrong" style={[styles.flex, { marginStart: spacing.sm }]}>
              {t("today.checkin")}
            </Text>
            {link(t("home.tiles.mood"), () => navigation.navigate("Mood"))}
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {MOODS.map((m) => (
              <Chip key={m.mood} label={t(m.key)} onPress={() => !busyAction && void checkIn(m)} />
            ))}
          </ScrollView>
        </Card>
      </Animated.View>
    ) : null;

  return (
    <View style={[styles.root, { backgroundColor: colors.canvas }]}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.sm, paddingBottom: bottomPad(insets.bottom + tabBar.height + 72), gap: spacing.xl }]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.textTertiary}
            onRefresh={() => {
              setRefreshing(true);
              void routinesQ.reload();
              void load(true);
            }}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        {/* A soft wash of the logo blue behind the header. */}
        <LinearGradient pointerEvents="none" colors={[withAlpha(colors.brand, 0.16), withAlpha(colors.brand, 0)]} style={[styles.wash, { height: insets.top + 260 }]} />

        {/* Header: date, greeting, progress, place */}
        <Animated.View entering={enter(0)} style={{ gap: spacing.md }}>
          <View style={styles.row}>
            <Text variant="label" color="secondary" style={styles.flex}>
              {dateLine}
            </Text>
            <SyncBadge />
            <NotificationBell onPress={() => navigation.navigate("Notifications")} />
          </View>
          <Text variant="title1" accessibilityRole="header" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
            {hello}
          </Text>
          <View style={[styles.row, { gap: spacing.lg }]}>
            <DayRing done={agenda.done} total={agenda.total} />
            <View style={[styles.flex, { gap: spacing.xs }]} accessible accessibilityLabel={[statusLine, agenda.total ? t("today.ring", { done: agenda.done, total: agenda.total }) : null].filter(Boolean).join(". ")}>
              <Text variant="title2">{statusLine}</Text>
              {agenda.plannedMinutes > 0 ? (
                <Text variant="callout" color="secondary">
                  {t("today.planned", { time: formatDuration(agenda.plannedMinutes) })}
                </Text>
              ) : agenda.total ? (
                <Text variant="callout" color="secondary">
                  {t("today.doneOf", { done: agenda.done, total: agenda.total })}
                </Text>
              ) : null}
            </View>
          </View>
          <View style={[styles.row, styles.wrap, { gap: spacing.sm }]}>
            {contexts.length ? (
              <Chip
                small
                leading={<Icon name="pin" size={14} color={colors.accentStrong} />}
                label={place ? place.replace(/^At\s+/i, "") : t("today.anywhere")}
                onPress={() => setPlaceOpen(true)}
                accessibilityLabel={`${t("today.where")}: ${place ?? t("today.anywhere")}`}
              />
            ) : null}
            {b?.peak.learned ? <Chip small leading={<Icon name="star" size={14} color={colors.accentStrong} />} label={t("today.peak", { time: b.peak.label })} /> : null}
          </View>
          {!aiOnline ? (
            <Text variant="caption" color="warning">
              {t("today.offlineAi")}
            </Text>
          ) : null}
        </Animated.View>

        <GuestBanner />

        {/* Decisions, not paragraphs: shared invitations, one Catch up card for everything overdue, one nudge at a time. */}
        <SharedWithYouCard onOpen={(id) => navigation.navigate("SharedTaskEdit", { id, mode: "accept" })} />
        {slipped ? (
          <Animated.View entering={enter(1)} layout={layout}>
            <NudgeCard
              icon="flag"
              tone="danger"
              title={slipped === 1 ? t("catch.card.title1") : t("catch.card.title", { count: slipped })}
              text={t("catch.card.text")}
              primary={{ label: t("catch.card.go"), onPress: () => navigation.navigate("CatchUp") }}
              onPress={() => navigation.navigate("CatchUp")}
            />
          </Animated.View>
        ) : null}
        {nudge ? (
          <Animated.View key={nudge.id} entering={enter(1)} layout={layout}>
            <NudgeCard
              icon={nudgeLook(nudge.kind).icon}
              tone={nudgeLook(nudge.kind).tone}
              title={nudge.title}
              text={nudge.message.startsWith(nudge.title) ? nudge.message.slice(nudge.title.length).replace(/^[.:\s]+/, "") || undefined : nudge.message}
              badge={nudges.length > 1 ? `1/${nudges.length}` : undefined}
              primary={nudge.actions[0] ? { label: (nudge.actions.find((a) => a.style === "primary") ?? nudge.actions[0]).label, loading: busyAction === nudge.id, onPress: () => void runAction(nudge.actions.find((a) => a.style === "primary") ?? nudge.actions[0], nudge.id) } : undefined}
              secondary={{ label: t("nudge.notNow"), onPress: () => setDismissed((d) => new Set(d).add(nudge.id)) }}
            />
          </Animated.View>
        ) : null}

        {/* Evening: check in first, then a look at tomorrow */}
        {evening ? checkinCard : null}

        {/* Next up: one focus card in the brand gradient */}
        {b?.nextUp ? (
          <Animated.View entering={enter(2)} layout={layout}>
            <PressableScale onPress={() => navigation.navigate("TaskDetail", { taskId: b.nextUp!.id })} accessibilityRole="button" accessibilityLabel={`${t("home.next.title")}: ${b.nextUp.title}`} style={[styles.hero, { borderRadius: radii.xl }]}>
              {/* The brand's deep blues in both themes, so white text keeps its contrast in dark mode too. */}
              <LinearGradient colors={[palettes.light.accent, palettes.light.accentStrong]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
              <View style={[styles.row, { gap: spacing.sm }]}>
                <Text variant="label" style={{ color: colors.onBrand, opacity: 0.85 }}>
                  {t("home.next.title").toUpperCase()}
                </Text>
                {b.nextUp.isOverdue ? (
                  <View style={[styles.badge, { backgroundColor: withAlpha(colors.onBrand, 0.2) }]}>
                    <Text variant="label" style={{ color: colors.onBrand, fontSize: 11 }}>
                      {t("plan.overdue")}
                    </Text>
                  </View>
                ) : null}
              </View>
              <Text variant="title1" numberOfLines={2} style={{ color: colors.onBrand }}>
                {b.nextUp.title}
              </Text>
              {b.nextUp.dueAt ? (
                <View style={[styles.row, { gap: spacing.xs }]}>
                  <Icon name="clock" size={14} color={colors.onBrand} />
                  <Text variant="callout" style={{ color: colors.onBrand, opacity: 0.9 }}>
                    {new Date(b.nextUp.dueAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}
                  </Text>
                </View>
              ) : null}
              <View style={[styles.actions, { marginTop: spacing.sm }]}>
                <HeroButton
                  primary
                  icon="play"
                  label={t("home.next.start")}
                  onPress={() => {
                    hapticTap();
                    void runAction({ label: "Start", payload: { type: "start_task", taskId: b.nextUp!.id } });
                  }}
                />
                <HeroButton
                  icon="check"
                  label={t("home.next.done")}
                  onPress={() => {
                    hapticDone();
                    void runAction({ label: "Done", payload: { type: "complete_task", taskId: b.nextUp!.id } });
                  }}
                />
                <HeroButton icon="clock" label={t("home.next.later")} onPress={() => void snoozeNext(b.nextUp!)} />
              </View>
              {(() => {
                const then = thenUp(b);
                return then ? (
                  <Text variant="caption" numberOfLines={1} style={{ color: colors.onBrand, opacity: 0.8 }}>
                    {then.time ? t("home.next.thenAt", { title: then.title, time: then.time }) : t("home.next.then", { title: then.title })}
                  </Text>
                ) : null;
              })()}
            </PressableScale>
          </Animated.View>
        ) : loading && !b ? (
          <Skeleton height={180} radius={radii.xl} />
        ) : null}

        {/* Today's agenda: the same items as Plan, in time order around "now" */}
        <Animated.View entering={enter(3)} layout={layout}>
          {section(t("today.agenda"), link(t("today.openPlan"), () => navigation.navigate("Plan")))}
          <Card style={styles.listCard}>
            {agenda.total === 0 ? (
              <View style={{ padding: spacing.lg, gap: spacing.md }}>
                <Text variant="callout" color="secondary">
                  {t("today.empty")}
                </Text>
                <View style={styles.actions}>
                  <Button title={t("action.addTask")} size="sm" kind="tonal" onPress={() => navigation.navigate("AddTask")} />
                  <Button title={t("today.planDay")} size="sm" kind="secondary" onPress={() => navigation.navigate("Assistant", { payload: { type: "plan_day" }, label: t("today.planDay"), nonce: Date.now() })} />
                </View>
              </View>
            ) : (
              <>
                {agenda.earlier.map((i, k) => (
                  <View key={i.key}>
                    {k > 0 ? divider : null}
                    <AgendaRow item={i} past color={colorOf(i)} onOpen={() => openItem(i)} onToggle={() => void toggle(i)} />
                  </View>
                ))}
                {agenda.earlier.length || agenda.later.length ? nowDivider : null}
                {agenda.later.map((i, k) => (
                  <View key={i.key}>
                    {k > 0 ? divider : null}
                    <AgendaRow item={i} color={colorOf(i)} onOpen={() => openItem(i)} onToggle={() => void toggle(i)} />
                  </View>
                ))}
                {agenda.anyTime.length ? (
                  <View style={[styles.groupHead, { backgroundColor: colors.canvas }]}>
                    <Text variant="label" color="tertiary">
                      {t("today.anyTime").toUpperCase()}
                    </Text>
                  </View>
                ) : null}
                {agenda.anyTime.map((i, k) => (
                  <View key={i.key}>
                    {k > 0 ? divider : null}
                    <AgendaRow item={i} color={colorOf(i)} onOpen={() => openItem(i)} onToggle={() => void toggle(i)} />
                  </View>
                ))}
              </>
            )}
          </Card>
        </Animated.View>

        {evening ? null : checkinCard}

        {evening && tomorrow.length ? (
          <Animated.View entering={enter(5)} layout={layout}>
            {section(t("home.tomorrow.title"), link(t("home.tomorrow.all"), () => navigation.navigate("TaskList", { filter: "tomorrow" })))}
            <Card style={styles.listCard}>
              {tomorrow.map((task, i) => (
                <View key={task.id}>
                  {i > 0 ? divider : null}
                  <ListItem title={task.title} subtitle={task.dueTime ?? undefined} leading={<Dot color={colors.priority[task.priority]} />} onPress={() => navigation.navigate("TaskDetail", { taskId: task.id })} />
                </View>
              ))}
            </Card>
          </Animated.View>
        ) : null}

        {/* Suggestions: compact cards; the confidence the FRs require shows as a badge. */}
        {b?.recommendations.length ? (
          <Animated.View entering={enter(6)} layout={layout} style={{ gap: spacing.md }}>
            {section(t("today.suggestions"))}
            {b.recommendations.slice(0, 3).map((r) => (
              <NudgeCard
                key={r.id}
                icon="sparkle"
                tone="accent"
                title={t("today.idea")}
                text={r.text}
                badge={t("today.confidence", { pct: Math.round(r.confidence * (r.confidence <= 1 ? 100 : 1)) })}
                primary={{ label: r.acceptLabel, onPress: () => void decideInsight(r.id, "accept") }}
                secondary={{ label: t("today.notNow"), onPress: () => void decideInsight(r.id, "dismiss") }}
              />
            ))}
          </Animated.View>
        ) : null}

        {error && !b ? (
          <Card>
            <Text variant="body">{error}</Text>
            <Button title="Try again" kind="secondary" size="sm" onPress={() => void load()} style={{ marginTop: spacing.md, alignSelf: "flex-start" }} />
          </Card>
        ) : null}

        <TutorialTip id="today-v3" title={t("today.agenda")} text={t("plan.dragHint")} />
      </ScrollView>

      {/* Content scrolling under the status bar fades out behind it. */}
      <LinearGradient pointerEvents="none" colors={[colors.canvas, withAlpha(colors.canvas, 0)]} style={[styles.statusFade, { height: insets.top + 12 }]} />
      {snack ? null : <FloatingAddButton onPress={() => navigation.navigate("AddTask")} />}
      <Snackbar text={snack?.text ?? null} action={snack?.action} onHide={() => setSnack(null)} />

      <Sheet visible={placeOpen} onClose={() => setPlaceOpen(false)} title={t("today.where")}>
        <Text variant="callout" color="secondary" style={{ marginBottom: spacing.md }}>
          {t("today.whereHint")}
        </Text>
        {[null, ...contexts].map((c) => (
          <ListItem
            key={c ?? "anywhere"}
            title={c ? c.replace(/^At\s+/i, "") : t("today.anywhere")}
            leading={<Icon name="pin" size={18} color={colors.textSecondary} />}
            trailing={place === c ? <Icon name="check" size={18} color={colors.accentStrong} /> : undefined}
            onPress={() => void switchContext(c)}
          />
        ))}
      </Sheet>
    </View>
  );
}

/** A button on the Next up gradient: white fill for the main action, translucent for the others. */
function HeroButton({ label, icon, onPress, primary }: { label: string; icon: "play" | "check" | "clock"; onPress: () => void; primary?: boolean }) {
  const { colors, radii } = useTheme();
  // On the always-deep-blue card: the white pill keeps the light theme's dark blue text in both themes.
  const fg = primary ? palettes.light.accentStrong : colors.onBrand;
  return (
    <PressableScale onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={[styles.heroBtn, { borderRadius: radii.pill, backgroundColor: primary ? colors.onBrand : withAlpha(colors.onBrand, 0.18) }]}>
      <Icon name={icon} size={16} color={fg} strokeWidth={2.2} />
      <Text variant="label" maxFontSizeMultiplier={1.2} style={{ color: fg, fontSize: 14 }}>
        {label}
      </Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 20 },
  wash: { position: "absolute", top: 0, left: 0, right: 0 },
  row: { flexDirection: "row", alignItems: "center" },
  wrap: { flexWrap: "wrap" },
  flex: { flex: 1 },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8, minHeight: 24 },
  chips: { gap: 8, paddingEnd: 8 },
  listCard: { padding: 0, overflow: "hidden" },
  divider: { height: StyleSheet.hairlineWidth, marginStart: 96 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  dotWrap: { width: 20, alignItems: "flex-start" },
  hero: { padding: 20, gap: 8, overflow: "hidden" },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  heroBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 44, paddingHorizontal: 10 },
  nowRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 6 },
  nowDot: { width: 8, height: 8, borderRadius: 4 },
  nowLine: { flex: 1, height: 1.5 },
  groupHead: { paddingHorizontal: 16, paddingVertical: 8 },
  more: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 48, borderTopWidth: StyleSheet.hairlineWidth },
  statusFade: { position: "absolute", top: 0, left: 0, right: 0 },
});
