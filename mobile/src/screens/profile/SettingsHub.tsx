import { ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeInDown, useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "../../components/icons/Icon";
import { PressableScale, Text } from "../../components/primitives";
import { useAuth } from "../../context/AuthContext";
import { usePreferences } from "../../context/PreferencesContext";
import { useLocale } from "../../i18n/LocaleProvider";
import type { StringKey } from "../../i18n/strings";
import { useTheme } from "../../theme/ThemeProvider";
import { clockLabel } from "../../components/plan/clock";
import { parseClock } from "../../utils/timeline";
import type { SettingsSection } from "./SettingsScreen";

const LANGUAGE_NAMES: Record<string, string> = { en: "English", ur: "اردو", ar: "العربية", es: "Español", fr: "Français", zh: "中文", hi: "हिन्दी" };

/**
 * The Settings hub (UI v3): six groups, each a card row with an icon, its name and what it's set to now, so most
 * people see their answer without opening anything.
 */
export function SettingsHub({ onOpen }: { onOpen: (s: SettingsSection) => void }) {
  const { colors, radii, spacing, mode } = useTheme();
  const { t } = useLocale();
  const insets = useSafeAreaInsets();
  const reduce = useReducedMotion();
  const { settings, categories } = usePreferences();
  const { dbUser } = useAuth();
  const range = (a?: string | null, b?: string | null) => {
    const x = parseClock(a);
    const y = parseClock(b);
    return x != null && y != null ? `${clockLabel(x)}–${clockLabel(y)}` : "";
  };
  const reminders = settings
    ? settings.notificationFrequency === "NONE"
      ? t("settings.freq.NONE")
      : `${t(`settings.method.${settings.notificationMethod}` as StringKey)} · ${t(`settings.devices.${settings.notificationDevices}` as StringKey)}`
    : "";
  const rows: Array<{ key: SettingsSection; icon: IconName; summary: string }> = [
    { key: "account", icon: "user", summary: [dbUser?.email, settings?.tier === "PRO" ? t("settings.hub.pro") : t("settings.hub.free")].filter(Boolean).join(" · ") },
    { key: "reminders", icon: "bell", summary: reminders },
    { key: "connected", icon: "globe", summary: t("settings.hub.connected") },
    { key: "day", icon: "today", summary: settings ? t("settings.hub.day", { work: range(settings.workStart, settings.workEnd), quiet: range(settings.quietStart, settings.quietEnd) }) : "" },
    { key: "labels", icon: "tag", summary: t("settings.hub.labels", { count: categories.length }) },
    { key: "language", icon: "speaker", summary: `${LANGUAGE_NAMES[settings?.language ?? "en"] ?? settings?.language ?? ""} · ${t(`settings.theme.${mode}` as StringKey)}` },
  ];
  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: insets.bottom + spacing.xxl }}>
      {rows.map((r, i) => (
        <Animated.View key={r.key} entering={reduce ? undefined : FadeInDown.delay(i * 35).duration(200)}>
          <PressableScale
            onPress={() => onOpen(r.key)}
            accessibilityRole="button"
            accessibilityLabel={`${t(`settings.section.${r.key}` as StringKey)}, ${r.summary}`}
            style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.hairline, borderRadius: radii.lg }]}
          >
            <View style={[styles.icon, { backgroundColor: colors.accentSoft, borderRadius: radii.md }]}>
              <Icon name={r.icon} size={20} color={colors.accentStrong} />
            </View>
            <View style={styles.flex}>
              <Text variant="bodyStrong">{t(`settings.section.${r.key}` as StringKey)}</Text>
              {r.summary ? (
                <Text variant="caption" color="secondary" numberOfLines={1}>
                  {r.summary}
                </Text>
              ) : null}
            </View>
            <Icon name="chevron" size={16} color={colors.textTertiary} />
          </PressableScale>
        </Animated.View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 14, padding: 16, minHeight: 72, borderWidth: StyleSheet.hairlineWidth },
  icon: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  flex: { flex: 1, gap: 2 },
});
