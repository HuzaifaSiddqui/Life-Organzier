import type { ReactNode } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useAuth } from "../context/AuthContext";
import { usePreferences } from "../context/PreferencesContext";
import { useLocale } from "../i18n/LocaleProvider";
import type { StringKey } from "../i18n/strings";
import { openAppScreen } from "../navigation/navigationRef";
import { showAlert } from "../services/dialog";
import { useTheme } from "../theme/ThemeProvider";
import { opacity } from "../theme/tokens";
import { lockReason, type Feature, type LockReason } from "../utils/featureAccess";
import { Icon } from "./icons/Icon";

/** The current user's lock for a feature (`null` = open). Guests come with guest mode (FR-OB-003). */
export function useFeatureLock(): (feature: Feature) => LockReason | null {
  const { isPro } = usePreferences();
  const { firebaseUser } = useAuth();
  const isGuest = Boolean(firebaseUser?.isAnonymous);
  return (feature) => lockReason(feature, { isPro, isGuest });
}

/**
 * Explains a locked feature: "Try Pro" (→ Settings, where the plan is chosen) or "Create an account" (guests → the
 * Create account screen).
 * Cancel keeps the user where they are.
 */
export function promptUnlock(reason: LockReason, featureName: string, t: (key: StringKey, vars?: Record<string, string | number>) => string): void {
  if (reason === "pro") {
    showAlert(t("lock.pro.title"), t("lock.pro.body", { feature: featureName }), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("lock.pro.go"), onPress: () => openAppScreen("Settings") },
    ]);
    return;
  }
  showAlert(t("lock.guest.title"), t("lock.guest.body", { feature: featureName }), [
    { text: t("common.cancel"), style: "cancel" },
    { text: t("lock.guest.go"), onPress: () => openAppScreen("CreateAccount") },
  ]);
}

/**
 * A feature the user can't use yet: the real control stays visible but dimmed, with a lock, and a tap anywhere on
 * it opens the unlock prompt instead of using it. Open features render their children unchanged.
 */
export function LockedFeature({
  feature,
  name,
  children,
  style,
}: {
  feature: Feature;
  /** What the prompt calls it ("WhatsApp reminders"). */
  name: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const lockFor = useFeatureLock();
  const { t } = useLocale();
  const { colors, spacing, radii } = useTheme();
  const reason = lockFor(feature);
  if (!reason) return <>{children}</>;
  return (
    <View style={style}>
      <View style={{ opacity: opacity.disabled }} pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        {children}
      </View>
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={() => promptUnlock(reason, name, t)}
        accessibilityRole="button"
        accessibilityLabel={t(reason === "pro" ? "lock.pro.a11y" : "lock.guest.a11y", { feature: name })}
      >
        <View style={[styles.badge, { backgroundColor: colors.surface, borderColor: colors.hairline, borderRadius: radii.pill, padding: spacing.xs, top: spacing.sm, end: spacing.sm }]}>
          <Icon name="lock" size={14} color={colors.textSecondary} />
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { position: "absolute", borderWidth: StyleSheet.hairlineWidth },
});
