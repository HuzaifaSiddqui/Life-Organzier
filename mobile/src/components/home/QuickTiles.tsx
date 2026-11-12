import { StyleSheet, View } from "react-native";
import { useLocale } from "../../i18n/LocaleProvider";
import type { StringKey } from "../../i18n/strings";
import { useTheme } from "../../theme/ThemeProvider";
import { Icon, type IconName } from "../icons/Icon";
import { PressableScale, Text } from "../primitives";

export type Tile = {
  key: string;
  icon: IconName;
  label: StringKey;
  /** Live caption (a count or state); null shows the plain hint instead. */
  caption: { key: string; vars?: Record<string, string> } | null;
  hint: StringKey;
  onPress: () => void;
};

/**
 * Home (UI v2): quick-access tiles in a 2 × 2 grid. Each shows a live caption from data Home already has
 * ("2 left today", "Check in"), or its plain hint while there is none (loading, no data).
 */
export function QuickTiles({ tiles }: { tiles: Tile[] }) {
  const { t } = useLocale();
  const { colors, spacing, radii } = useTheme();
  return (
    <View style={[styles.grid, { gap: spacing.sm }]}>
      {tiles.map((tile) => {
        const caption = tile.caption ? t(tile.caption.key as StringKey, tile.caption.vars) : t(tile.hint);
        return (
          <PressableScale
            key={tile.key}
            onPress={tile.onPress}
            accessibilityRole="button"
            accessibilityLabel={`${t(tile.label)}, ${caption}`}
            style={[styles.tile, { backgroundColor: colors.surface, borderColor: colors.hairline, borderRadius: radii.md, padding: spacing.md, gap: spacing.md }]}
            pressedStyle={{ backgroundColor: colors.accentSoft }}
          >
            <View style={[styles.icon, { backgroundColor: colors.accentSoft, borderRadius: radii.sm }]}>
              <Icon name={tile.icon} size={18} color={colors.accentStrong} />
            </View>
            <View style={styles.flex}>
              <Text variant="bodyStrong" numberOfLines={1}>
                {t(tile.label)}
              </Text>
              <Text variant="caption" color={tile.caption ? "accent" : "secondary"} numberOfLines={1}>
                {caption}
              </Text>
            </View>
          </PressableScale>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap" },
  tile: { flexBasis: "48%", flexGrow: 1, flexDirection: "row", alignItems: "center", minHeight: 64, borderWidth: StyleSheet.hairlineWidth },
  icon: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  flex: { flex: 1 },
});
