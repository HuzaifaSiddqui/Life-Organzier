import { StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocale } from "../i18n/LocaleProvider";
import { useTheme } from "../theme/ThemeProvider";
import { useLayout } from "../theme/useLayout";
import { Icon } from "./icons/Icon";
import { PressableScale } from "./primitives";

/**
 * UI v2: the "+" within thumb reach, bottom right above the bottom nav (Home and Tasks). Opens the task form.
 * Wide windows (desktop) have "New task" in the Sidebar instead, so it renders nothing there.
 */
export function FloatingAddButton({ onPress }: { onPress: () => void }) {
  const { t } = useLocale();
  const { colors, elevation } = useTheme();
  const insets = useSafeAreaInsets();
  const { isWide } = useLayout();
  if (isWide) return null;
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t("home.fab")}
      style={[styles.fab, elevation(2), { backgroundColor: colors.accent, borderColor: colors.accent, bottom: Math.max(insets.bottom, 8) + 84 }]}
      pressedStyle={{ opacity: 0.9 }}
    >
      <Icon name="plus" size={26} color={colors.onAccent} strokeWidth={2.2} />
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  fab: { position: "absolute", right: 20, width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center" },
});
