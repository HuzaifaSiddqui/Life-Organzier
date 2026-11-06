import { StyleSheet, View } from "react-native";
import { useLocale } from "../../i18n/LocaleProvider";
import type { StringKey } from "../../i18n/strings";
import { useTheme } from "../../theme/ThemeProvider";
import { STATE_ICON, STATE_TONE, type ParticipantState } from "../../utils/collab";
import { Icon } from "../icons/Icon";
import { Text } from "../ui";

/** A participant's state on a shared task: a tinted pill with an icon and a label (colour is never the only signal). */
export function StateChip({ state }: { state: ParticipantState }) {
  const { t } = useLocale();
  const { colors, spacing, radii } = useTheme();
  const tone = STATE_TONE[state];
  const fg = tone === "neutral" ? colors.textSecondary : colors[tone].fg;
  const bg = tone === "neutral" ? colors.skeleton : colors[tone].bg;
  return (
    <View style={[styles.pill, { backgroundColor: bg, borderRadius: radii.pill, paddingHorizontal: spacing.sm, gap: spacing.xs }]}>
      <Icon name={STATE_ICON[state]} size={14} color={fg} />
      <Text variant="label" style={{ color: fg }}>
        {t(`collab.state.${state}` as StringKey)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: "row", alignItems: "center", minHeight: 24 },
});
