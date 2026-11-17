import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useTheme } from "../../theme/ThemeProvider";
import { Icon, type IconName } from "../icons/Icon";
import { Button, PressableScale, Text } from "../primitives";

export type NudgeTone = "danger" | "warning" | "info" | "accent";

/**
 * One compact decision card (UI v3, docs/design.md "Today"): an icon square in the tone's colour, a bold one-line
 * title, at most two lines of detail, one main action and a quiet second one. Replaces the paragraph rows of v2's
 * "Needs you" and the suggestion list. `badge` (e.g. "1/3", "82% sure") sits by the title.
 */
export function NudgeCard({
  icon,
  tone,
  title,
  text,
  badge,
  primary,
  secondary,
  onPress,
}: {
  icon: IconName;
  tone: NudgeTone;
  title: string;
  text?: string;
  badge?: string;
  primary?: { label: string; onPress: () => void; loading?: boolean };
  secondary?: { label: string; onPress: () => void };
  onPress?: () => void;
}) {
  const { colors, radii, spacing, elevation } = useTheme();
  const fg = tone === "accent" ? colors.accentStrong : colors[tone].fg;
  const bg = tone === "accent" ? colors.accentSoft : colors[tone].bg;
  const body: ReactNode = (
    <>
      <View style={[styles.row, { gap: spacing.md }]}>
        <View style={[styles.icon, { backgroundColor: bg, borderRadius: radii.md }]}>
          <Icon name={icon} size={20} color={fg} />
        </View>
        <View style={[styles.flex, { gap: 2 }]}>
          <View style={[styles.row, { gap: spacing.sm }]}>
            <Text variant="bodyStrong" numberOfLines={1} style={styles.flex}>
              {title}
            </Text>
            {badge ? (
              <View style={[styles.badge, { backgroundColor: colors.skeleton, borderRadius: radii.pill }]}>
                <Text variant="label" color="secondary" style={{ fontSize: 11 }}>
                  {badge}
                </Text>
              </View>
            ) : null}
          </View>
          {text ? (
            <Text variant="callout" color="secondary" numberOfLines={2}>
              {text}
            </Text>
          ) : null}
        </View>
      </View>
      {primary || secondary ? (
        <View style={[styles.row, { gap: spacing.sm, justifyContent: "flex-end" }]}>
          {secondary ? <Button title={secondary.label} size="sm" kind="ghost" onPress={secondary.onPress} /> : null}
          {primary ? <Button title={primary.label} size="sm" kind={tone === "danger" ? "primary" : "tonal"} loading={primary.loading} onPress={primary.onPress} /> : null}
        </View>
      ) : null}
    </>
  );
  const style = [styles.card, elevation(1), { borderRadius: radii.lg, padding: spacing.lg, gap: spacing.md }];
  return onPress ? (
    <PressableScale onPress={onPress} accessibilityRole="button" accessibilityLabel={[title, text].filter(Boolean).join(". ")} style={style}>
      {body}
    </PressableScale>
  ) : (
    <View style={style} accessibilityLabel={[title, text].filter(Boolean).join(". ")}>
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {},
  row: { flexDirection: "row", alignItems: "center" },
  flex: { flex: 1 },
  icon: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  badge: { paddingHorizontal: 8, paddingVertical: 2 },
});
