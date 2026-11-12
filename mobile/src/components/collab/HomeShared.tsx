import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { usePop } from "../../theme/usePop";
import { useLocale } from "../../i18n/LocaleProvider";
import { getCollabSummary, getSharedTasks, type SharedTask } from "../../services/collabApi";
import { useTheme } from "../../theme/ThemeProvider";
import { badgeText, personLabel } from "../../utils/collab";
import { formatDue } from "../../utils/format";
import { Icon } from "../icons/Icon";
import { Button, Card, Text } from "../ui";

/**
 * Home (COLLAB_TASKS): the bell with an unread badge, and a "Shared with you" card for invitations waiting for an
 * answer. Both render nothing while the server has the feature off. They refresh whenever Home is focused.
 */
function useCollabHome(): { unread: number; cards: SharedTask[] } | null {
  const [state, setState] = useState<{ unread: number; cards: SharedTask[] } | null>(null);
  useFocusEffect(
    useCallback(() => {
      let live = true;
      void (async () => {
        try {
          const summary = await getCollabSummary();
          if (!summary) return live && setState(null);
          const { cards } = summary.cards ? await getSharedTasks() : { cards: [] };
          if (live) setState({ unread: summary.unread, cards });
        } catch {
          // offline: keep what was shown
        }
      })();
      return () => {
        live = false;
      };
    }, []),
  );
  return state;
}

export function NotificationBell({ onPress }: { onPress: () => void }) {
  const { t } = useLocale();
  const { colors, radii, motion } = useTheme();
  const state = useCollabHome();
  // The badge pops when the unread count changes (not on first show).
  const badgePop = usePop(state?.unread ?? 0, { from: motion.pop.badge, duration: motion.duration.fast, when: Boolean(state?.unread) });
  if (!state) return null;
  const badge = badgeText(state.unread);
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={badge ? t("collab.notices.bell", { count: String(state.unread) }) : t("collab.notices.bellNone")}
      style={styles.bell}
    >
      <Icon name="bell" size={22} color={colors.text} />
      {badge ? (
        <Animated.View style={[styles.badge, { backgroundColor: colors.danger.fg, borderRadius: radii.pill, borderColor: colors.canvas }, badgePop]}>
          <Text variant="caption" style={{ color: colors.onAccent, fontSize: 10, lineHeight: 12 }} tabular>
            {badge}
          </Text>
        </Animated.View>
      ) : null}
    </Pressable>
  );
}

export function SharedWithYouCard({ onOpen }: { onOpen: (sharedTaskId: string) => void }) {
  const { t } = useLocale();
  const { colors, spacing } = useTheme();
  const state = useCollabHome();
  if (!state?.cards.length) return null;
  const shown = state.cards.slice(0, 2);
  return (
    <Card tone="accent" style={{ gap: spacing.md }}>
      <View style={[styles.row, { gap: spacing.sm }]}>
        <Icon name="people" size={20} color={colors.accent} />
        <Text variant="headline" style={styles.flex}>
          {t("collab.home.title")}
        </Text>
      </View>
      {shown.map((s) => (
        <View key={s.id} style={[styles.row, { gap: spacing.sm }]}>
          <View style={styles.flex}>
            <Text variant="body" numberOfLines={2}>
              {s.title}
            </Text>
            <Text variant="caption" color="secondary" numberOfLines={1}>
              {[t(s.kind === "COLLAB" ? "collab.card.together" : "collab.card.assigned", { name: personLabel(s.owner) }), s.dueDate ? formatDue({ dueDate: s.dueDate, dueTime: s.dueTime } as never) : null].filter(Boolean).join(" · ")}
            </Text>
          </View>
          <Button title={t("collab.home.open")} kind="tonal" size="sm" onPress={() => onOpen(s.id)} accessibilityLabel={`${t("collab.home.open")} ${s.title}`} />
        </View>
      ))}
      {state.cards.length > shown.length ? (
        <Text variant="caption" color="secondary">
          {t("collab.home.more", { count: String(state.cards.length - shown.length) })}
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  flex: { flex: 1 },
  bell: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  badge: { position: "absolute", top: 4, right: 2, minWidth: 18, height: 18, paddingHorizontal: 4, alignItems: "center", justifyContent: "center", borderWidth: 2 },
});
