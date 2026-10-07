import { useEffect, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { FadeInDown, FadeOutDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { plural, useLocale } from "../../i18n/LocaleProvider";
import { getSyncStatus, retrySync, subscribeSync, type SyncStatus } from "../../services/syncEngine";
import { useTheme } from "../../theme/ThemeProvider";
import { radii, spacing, typeScale } from "../../theme/tokens";
import { friendlyError } from "../../utils/friendlyError";
import { Button, Dot, PressableScale } from "./controls";
import { Sheet } from "./surfaces";
import { Text } from "./Text";

/** Space reserved for the floating bottom nav so snackbars sit above it. */
const BOTTOM_NAV_CLEARANCE = 80;

/**
 * Transient message with optional action (use "Undo" for delete / complete / edit).
 * Stays 6s with an action, 3.5s without.
 */
export function Snackbar({
  text,
  tone = "neutral",
  onHide,
  action,
}: {
  text: string | null;
  tone?: "neutral" | "success" | "warning" | "danger";
  onHide: () => void;
  action?: { label: string; onPress: () => void };
}) {
  const { colors, motion } = useTheme();
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (!text) return;
    const t = setTimeout(onHide, action ? motion.snackbar.withAction : motion.snackbar.plain);
    return () => clearTimeout(t);
  }, [text, onHide, action, motion.snackbar]);
  if (!text) return null;
  return (
    <Animated.View
      entering={FadeInDown.duration(motion.duration.base)}
      exiting={FadeOutDown.duration(motion.duration.fast)}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[styles.snackbar, { backgroundColor: colors.inverseSurface, bottom: insets.bottom + BOTTOM_NAV_CLEARANCE }]}
    >
      {tone !== "neutral" ? <Dot color={colors[tone].fg} /> : null}
      <Text variant="callout" color="onInverse" style={styles.flex}>
        {text}
      </Text>
      {action ? (
        <PressableScale onPress={action.onPress} hitSlop={12} accessibilityRole="button" style={styles.snackAction}>
          <Text variant="bodyStrong" color="onInverse">
            {action.label}
          </Text>
        </PressableScale>
      ) : null}
    </Animated.View>
  );
}

/**
 * Empty screen/section: short helpful message and one primary action.
 * Copy should teach by example, e.g. "Try typing 'Submit report Friday 3 PM'".
 */
export function EmptyState({ icon, title, text, action }: { icon?: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <View style={styles.empty}>
      {typeof icon === "string" ? (
        <Text style={styles.emoji} accessibilityElementsHidden importantForAccessibility="no">
          {icon}
        </Text>
      ) : (
        icon
      )}
      <Text variant="headline" center accessibilityRole="header">
        {title}
      </Text>
      {text ? (
        <Text variant="callout" color="secondary" center>
          {text}
        </Text>
      ) : null}
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </View>
  );
}

/** Inline, recoverable error. Pass the caught error; copy is chosen from its kind, never its raw message. */
export function ErrorState({ error, onRetry, assistant }: { error: unknown; onRetry?: () => void; assistant?: boolean }) {
  const { t } = useLocale();
  const kind = assistant ? "assistant" : friendlyError(error);
  return (
    <View style={styles.empty} accessibilityLiveRegion="polite">
      <Text variant="headline" center accessibilityRole="header">
        {t(`error.${kind}.title`)}
      </Text>
      <Text variant="callout" color="secondary" center>
        {t(`error.${kind}.body`)}
      </Text>
      {onRetry ? <Button title={t("common.retry")} kind="secondary" size="sm" onPress={onRetry} style={styles.emptyAction} /> : null}
    </View>
  );
}

/** Offline / pending / syncing / failed indicator with manual retry (FR-EH-001, FR-EH-002). Hidden when all is synced. */
export function SyncBadge() {
  const { colors } = useTheme();
  const { t } = useLocale();
  const [s, setS] = useState<SyncStatus>(getSyncStatus());
  useEffect(() => subscribeSync(setS), []);
  if (s.online && !s.failed && !s.syncing && s.pending === 0) return null;
  const label = !s.online
    ? s.pending
      ? t(plural(s.pending, "sync.offlinePending.one", "sync.offlinePending.other"), { count: s.pending })
      : t("sync.offline")
    : s.failed
      ? t("sync.failed")
      : s.syncing
        ? t("sync.syncing")
        : t(plural(s.pending, "sync.pending.one", "sync.pending.other"), { count: s.pending });
  const retryable = s.failed || !s.online;
  const dot = !s.online ? colors.textTertiary : s.failed ? colors.danger.fg : colors.warning.fg;
  return (
    <PressableScale
      onPress={retryable ? () => void retrySync() : undefined}
      scale={retryable}
      accessibilityRole={retryable ? "button" : "text"}
      accessibilityLabel={retryable ? `${label}. ${t("common.retry")}` : label}
      accessibilityLiveRegion="polite"
      style={[styles.sync, { backgroundColor: s.failed ? colors.danger.bg : colors.surface, borderColor: colors.hairline }]}
    >
      <Dot color={dot} />
      <Text variant="caption" tabular style={styles.flexShrink}>
        {label}
      </Text>
      {retryable ? (
        <Text variant="label" color="accent">
          {t("common.retry")}
        </Text>
      ) : null}
    </PressableScale>
  );
}

/**
 * "Keep mine / Use cloud version" sheet for sync conflicts.
 * ponytail: not wired — syncEngine has no conflict detection yet; wire it when the engine reports conflicts.
 */
export function ConflictSheet({
  visible,
  mine,
  cloud,
  onKeepMine,
  onUseCloud,
  onClose,
}: {
  visible: boolean;
  mine: string;
  cloud: string;
  onKeepMine: () => void;
  onUseCloud: () => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  return (
    <Sheet visible={visible} onClose={onClose} title={t("conflict.title")}>
      <Text variant="callout" color="secondary">
        {t("conflict.body")}
      </Text>
      <View style={styles.conflictRow}>
        <Text variant="label" color="secondary">
          {t("conflict.mine")}
        </Text>
        <Text variant="body">{mine}</Text>
      </View>
      <View style={styles.conflictRow}>
        <Text variant="label" color="secondary">
          {t("conflict.cloud")}
        </Text>
        <Text variant="body">{cloud}</Text>
      </View>
      <Button title={t("conflict.keepMine")} onPress={onKeepMine} />
      <Button title={t("conflict.useCloud")} kind="secondary" onPress={onUseCloud} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  flexShrink: { flexShrink: 1 },
  snackbar: {
    position: "absolute",
    start: spacing.lg,
    end: spacing.lg,
    borderRadius: radii.md,
    minHeight: 48,
    paddingVertical: spacing.sm,
    paddingStart: spacing.lg,
    paddingEnd: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    zIndex: 20,
  },
  snackAction: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  empty: { alignItems: "center", paddingVertical: spacing.xxl, paddingHorizontal: spacing.xl, gap: spacing.sm },
  emoji: { fontSize: typeScale.display.fontSize, lineHeight: typeScale.display.lineHeight + spacing.xs },
  emptyAction: { marginTop: spacing.sm },
  sync: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    alignSelf: "flex-start",
    minHeight: 32,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  conflictRow: { gap: spacing.xs },
});
