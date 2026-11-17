import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { signOut } from "firebase/auth";
import { LinearGradient } from "expo-linear-gradient";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeInDown, useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GuestBanner } from "../../components/GuestBanner";
import { Icon, type IconName } from "../../components/icons/Icon";
import { promptUnlock, useFeatureLock } from "../../components/LockedFeature";
import { clockLabel } from "../../components/plan/clock";
import { ProfilePhoto } from "../../components/profile/ProfilePhoto";
import { Card, PressableScale, Skeleton, SyncBadge, Text } from "../../components/primitives";
import { useAuth } from "../../context/AuthContext";
import { usePreferences } from "../../context/PreferencesContext";
import { useCachedQuery, useCacheLoader } from "../../hooks/useCachedQuery";
import { useLocale } from "../../i18n/LocaleProvider";
import { auth } from "../../lib/firebase";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getCollabSummary, type Summary } from "../../services/collabApi";
import { showAlert } from "../../services/dialog";
import { signOutGuest } from "../../services/guest";
import { getAnalytics, type Analytics } from "../../services/insightsApi";
import { clearGeofenceData } from "../../services/locationReminders";
import { flushOutbox } from "../../services/outbox";
import { unregisterPush } from "../../services/push";
import { clearAllReminders } from "../../services/reminders";
import { useTheme } from "../../theme/ThemeProvider";
import { opacity, tabBar, withAlpha } from "../../theme/tokens";
import { useLayout } from "../../theme/useLayout";

type Props = NativeStackScreenProps<MainStackParamList, "Profile">;

/**
 * UI v3 Me (docs/design.md "Me"): who you are (avatar, plan), how your week went (opens Insights), your things as
 * tiles (Routines, Mood, Documents, What I know), People & sharing, Settings, Sign out.
 */
export function ProfileScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { bottomPad } = useLayout();
  const { colors, spacing, radii } = useTheme();
  const { t } = useLocale();
  const reduce = useReducedMotion();
  const { dbUser, firebaseUser } = useAuth();
  const isGuest = Boolean(firebaseUser?.isAnonymous);
  const lockFor = useFeatureLock();
  const { settings, isPro } = usePreferences();
  const name = isGuest && !dbUser?.displayName ? t("guest.name") : (dbUser?.displayName ?? dbUser?.email?.split("@")[0] ?? "");
  const week = useCachedQuery<Analytics>("me-week", () => getAnalytics("week"));
  // Task collaboration: shown only when the server has it on (null = off or not reachable yet).
  const [collab, setCollab] = useState<Summary | null>(null);
  const cached = useCacheLoader();
  useFocusEffect(
    useCallback(() => {
      cached("collab-summary", getCollabSummary, setCollab).catch(() => undefined);
      void week.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cached]),
  );
  const waitingForMe = collab ? collab.requests + collab.cards : 0;
  const enter = (i: number) => (reduce ? undefined : FadeInDown.delay(50 * i).duration(220));

  const leave = () => {
    const end = (fn: () => Promise<void>) => void Promise.all([flushOutbox(), clearAllReminders(), clearGeofenceData(), unregisterPush()]).finally(() => void fn());
    // A guest has no account to come back to: signing out deletes the guest data (FR-OB-003 §4 warning).
    if (isGuest) {
      showAlert(t("guest.signOut.title"), t("guest.signOut.body"), [
        { text: t("common.cancel"), style: "cancel" },
        { text: t("guest.createAccount"), onPress: () => navigation.navigate("CreateAccount") },
        { text: t("guest.signOut.confirm"), style: "destructive", onPress: () => end(signOutGuest) },
      ]);
      return;
    }
    end(() => signOut(auth));
  };

  const tiles: Array<{ icon: IconName; title: string; hint: string; go: () => void }> = [
    { icon: "repeat", title: t("me.routines"), hint: t("me.routinesHint"), go: () => navigation.navigate("Routines") },
    { icon: "pulse", title: t("me.mood"), hint: t("me.moodHint"), go: () => navigation.navigate("Mood") },
    { icon: "doc", title: t("me.docs"), hint: t("me.docsHint"), go: () => navigation.navigate("Documents") },
    { icon: "memory", title: t("me.memory"), hint: t("me.memoryHint"), go: () => navigation.navigate("Memory") },
  ];
  const sharingLock = lockFor("sharing");

  return (
    <View style={[styles.root, { backgroundColor: colors.canvas }]}>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.sm, paddingBottom: bottomPad(insets.bottom + tabBar.height + 48), gap: spacing.xl }]} showsVerticalScrollIndicator={false}>
        <LinearGradient pointerEvents="none" colors={[withAlpha(colors.brand, 0.16), withAlpha(colors.brand, 0)]} style={[styles.wash, { height: insets.top + 220 }]} />
        <View style={styles.row}>
          <Text variant="title1" accessibilityRole="header" style={styles.flex}>
            {t("me.title")}
          </Text>
          <SyncBadge />
        </View>

        {/* Who */}
        <Animated.View entering={enter(0)} style={[styles.row, { gap: spacing.lg }]}>
          <ProfilePhoto size={72} />
          <View style={[styles.flex, { gap: 2 }]}>
            <Text variant="title2" numberOfLines={1}>
              {name}
            </Text>
            <Text variant="callout" color="secondary" numberOfLines={1}>
              {isGuest ? t("guest.notBackedUp") : dbUser?.email}
            </Text>
            <View style={[styles.row, { gap: spacing.sm, marginTop: spacing.xs }]}>
              <View style={[styles.plan, { backgroundColor: isPro ? colors.accent : colors.skeleton, borderRadius: radii.pill }]}>
                <Text variant="label" style={{ color: isPro ? colors.onAccent : colors.textSecondary, fontSize: 11 }}>
                  {isGuest ? t("guest.plan") : isPro ? t("me.pro") : t("me.free")}
                </Text>
              </View>
              {settings?.currentContext ? (
                <Text variant="caption" color="tertiary" numberOfLines={1}>
                  {settings.currentContext}
                </Text>
              ) : null}
            </View>
          </View>
        </Animated.View>

        <GuestBanner />

        {/* Your week → Insights */}
        <Animated.View entering={enter(1)}>
          <WeekCard data={week.data} loading={week.loading} onOpen={() => navigation.navigate("Insights")} />
        </Animated.View>

        {/* Your things */}
        <Animated.View entering={enter(2)}>
          <Text variant="label" color="tertiary" style={styles.sectionLabel} accessibilityRole="header">
            {t("me.yourStuff").toUpperCase()}
          </Text>
          <View style={styles.grid}>
            {tiles.map((tile) => (
              <PressableScale
                key={tile.title}
                onPress={tile.go}
                accessibilityRole="button"
                accessibilityLabel={`${tile.title}, ${tile.hint}`}
                style={[styles.tile, { backgroundColor: colors.surface, borderColor: colors.hairline, borderRadius: radii.lg }]}
              >
                <View style={[styles.tileIcon, { backgroundColor: colors.accentSoft, borderRadius: radii.md }]}>
                  <Icon name={tile.icon} size={22} color={colors.accentStrong} />
                </View>
                <Text variant="bodyStrong" numberOfLines={1}>
                  {tile.title}
                </Text>
                <Text variant="caption" color="tertiary" numberOfLines={2}>
                  {tile.hint}
                </Text>
              </PressableScale>
            ))}
          </View>
        </Animated.View>

        {/* People, settings, sign out */}
        <Animated.View entering={enter(3)}>
          <Card style={styles.listCard}>
            {collab ? (
              <>
                <Row
                  icon="people"
                  title={t("me.people")}
                  subtitle={waitingForMe ? t("collab.profile.waiting", { count: waitingForMe }) : t("collab.profile.subtitle")}
                  badge={waitingForMe || undefined}
                  locked={Boolean(sharingLock)}
                  onPress={() => (sharingLock ? promptUnlock(sharingLock, t("lock.name.sharing"), t) : navigation.navigate("Collab", waitingForMe ? { tab: "requests" } : undefined))}
                />
                <View style={[styles.divider, { backgroundColor: colors.hairline }]} />
              </>
            ) : null}
            <Row icon="settings" title={t("me.settings")} subtitle={t("me.settingsHint")} onPress={() => navigation.navigate("Settings")} />
            <View style={[styles.divider, { backgroundColor: colors.hairline }]} />
            <Row icon="pin" title={t("me.places")} onPress={() => navigation.navigate("SavedPlaces")} />
          </Card>
        </Animated.View>

        <Pressable onPress={leave} accessibilityRole="button" style={({ pressed }) => [styles.signOut, { borderColor: colors.hairline, borderRadius: radii.md }, pressed && { backgroundColor: colors.danger.bg }]}>
          <Icon name="logout" color={colors.danger.fg} />
          <Text variant="bodyStrong" color="danger">
            {t("me.signOut")}
          </Text>
        </Pressable>
      </ScrollView>
      <LinearGradient pointerEvents="none" colors={[colors.canvas, withAlpha(colors.canvas, 0)]} style={[styles.statusFade, { height: insets.top + 12 }]} />
    </View>
  );
}

function Row({ icon, title, subtitle, onPress, badge, locked }: { icon: IconName; title: string; subtitle?: string; onPress: () => void; badge?: number; locked?: boolean }) {
  const { colors, radii } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[title, subtitle].filter(Boolean).join(", ")}
      style={({ pressed }) => [styles.item, pressed && { backgroundColor: colors.accentSoft }, locked ? { opacity: opacity.disabled } : null]}
    >
      <Icon name={icon} color={colors.textSecondary} />
      <View style={styles.flex}>
        <Text variant="body">{title}</Text>
        {subtitle ? (
          <Text variant="caption" color="tertiary" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {badge ? (
        <View style={[styles.badge, { backgroundColor: colors.danger.fg, borderRadius: radii.pill }]}>
          <Text variant="label" style={{ color: colors.onAccent, fontSize: 11 }}>
            {badge}
          </Text>
        </View>
      ) : null}
      <Icon name={locked ? "lock" : "chevron"} size={16} color={colors.textTertiary} />
    </Pressable>
  );
}

/** How the week went: done count, rate, a bar per day, the best hour. Tapping opens Insights. */
function WeekCard({ data, loading, onOpen }: { data: Analytics | null; loading: boolean; onOpen: () => void }) {
  const { colors, spacing, radii } = useTheme();
  const { t } = useLocale();
  if (loading && !data) return <Skeleton height={168} radius={radii.xl} />;
  const days = data?.trend.slice(-7) ?? [];
  const max = Math.max(1, ...days.map((d) => d.completed));
  const done = data?.totals.completed ?? 0;
  const rate = data ? Math.round((data.totals.onTimeRate ?? data.totals.completionRate) * (((data.totals.onTimeRate ?? data.totals.completionRate) <= 1 ? 100 : 1))) : 0;
  return (
    <PressableScale onPress={onOpen} accessibilityRole="button" accessibilityLabel={`${t("me.week")}: ${t("me.weekDone", { count: done })}. ${t("me.weekOpen")}`} style={[styles.week, { backgroundColor: colors.surface, borderColor: colors.hairline, borderRadius: radii.xl, gap: spacing.md }]}>
      <View style={styles.row}>
        <Text variant="label" color="tertiary" style={styles.flex}>
          {t("me.week").toUpperCase()}
        </Text>
        <Text variant="label" color="accent">
          {t("me.weekOpen")}
        </Text>
        <Icon name="chevron" size={14} color={colors.accentStrong} />
      </View>
      {done === 0 ? (
        <Text variant="callout" color="secondary">
          {t("me.weekEmpty")}
        </Text>
      ) : (
        <View style={[styles.row, { alignItems: "flex-end", gap: spacing.lg }]}>
          <View style={{ gap: 2 }}>
            <Text variant="display" tabular>
              {done}
            </Text>
            <Text variant="caption" color="secondary">
              {t(data?.totals.onTimeRate != null ? "me.weekRate" : "me.weekRateAny", { pct: rate })}
            </Text>
          </View>
          <View style={[styles.bars, styles.flex]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {days.map((d, i) => (
              <View key={`${d.label}-${i}`} style={styles.barCol}>
                <View style={[styles.barTrack, { backgroundColor: colors.chartGrid, borderRadius: radii.sm }]}>
                  <View style={{ height: `${Math.max(6, (d.completed / max) * 100)}%`, backgroundColor: i === days.length - 1 ? colors.accent : withAlpha(colors.accent, 0.45), borderRadius: radii.sm }} />
                </View>
                <Text variant="caption" color="tertiary" maxFontSizeMultiplier={1} style={{ fontSize: 10 }}>
                  {d.label.slice(0, 1)}
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}
      {data?.bestHour != null ? (
        <View style={[styles.row, { gap: spacing.xs }]}>
          <Icon name="star" size={14} color={colors.accentStrong} />
          <Text variant="caption" color="secondary">
            {t("me.bestHour", { time: clockLabel(data.bestHour * 60) })}
          </Text>
        </View>
      ) : null}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 20 },
  wash: { position: "absolute", top: 0, left: 0, right: 0 },
  statusFade: { position: "absolute", top: 0, left: 0, right: 0 },
  row: { flexDirection: "row", alignItems: "center" },
  flex: { flex: 1 },
  plan: { paddingHorizontal: 10, paddingVertical: 3 },
  sectionLabel: { marginBottom: 8 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  tile: { width: "47%", flexGrow: 1, padding: 16, gap: 6, borderWidth: StyleSheet.hairlineWidth, minHeight: 124 },
  tileIcon: { width: 44, height: 44, alignItems: "center", justifyContent: "center", marginBottom: 4 },
  listCard: { padding: 0, overflow: "hidden" },
  divider: { height: StyleSheet.hairlineWidth, marginStart: 52 },
  item: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 60, paddingHorizontal: 16, paddingVertical: 10 },
  badge: { minWidth: 22, height: 22, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
  signOut: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, minHeight: 52, borderWidth: 1 },
  week: { padding: 20, borderWidth: StyleSheet.hairlineWidth },
  bars: { flexDirection: "row", alignItems: "flex-end", gap: 6, height: 72 },
  barCol: { flex: 1, alignItems: "center", gap: 4, height: "100%" },
  barTrack: { flex: 1, width: "100%", justifyContent: "flex-end", overflow: "hidden" },
});
