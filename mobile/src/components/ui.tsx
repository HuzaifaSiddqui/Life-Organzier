import { useState, type ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type TextStyle } from "react-native";
import { usePreferences } from "../context/PreferencesContext";
import { useLocale } from "../i18n/LocaleProvider";
import { useTheme } from "../theme/ThemeProvider";
import { palettes, radii, spacing, typeScale } from "../theme/tokens";
import { Button, Card, Chip, Sheet, Text } from "./primitives";

export * from "./primitives";

export function SectionTitle({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <View style={styles.sectionRow}>
      <Text variant="headline" accessibilityRole="header" style={styles.flexShrink}>
        {title}
      </Text>
      {right}
    </View>
  );
}

/** Static fill (no width animation — layout props are never animated). */
export function ProgressBar({ value, color, height = 6, accessibilityLabel }: { value: number; color?: string; height?: number; accessibilityLabel?: string }) {
  const { colors } = useTheme();
  const v = Math.max(0, Math.min(100, value));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(v) }}
      style={[styles.track, { height, borderRadius: height, backgroundColor: colors.skeleton }]}
    >
      <View style={{ width: `${v}%`, backgroundColor: color ?? colors.accent, height, borderRadius: height }} />
    </View>
  );
}

/** "I'm 82% sure…" — confidence is always shown to the user (FR-PL-002 §4). */
export function ConfidenceMeter({ value, label }: { value: number; label?: string }) {
  const { colors } = useTheme();
  const pct = Math.round(value * (value <= 1 ? 100 : 1));
  const color = pct >= 80 ? colors.success.fg : pct >= 60 ? colors.accent : colors.warning.fg;
  return (
    <View style={styles.meter}>
      <View style={styles.rowBetween}>
        <Text variant="caption" color="secondary">
          {label ?? "Confidence"}
        </Text>
        <Text variant="label" tabular style={{ color }}>
          {pct}%
        </Text>
      </View>
      <ProgressBar value={pct} color={color} height={4} />
    </View>
  );
}

export function HighlightText({ text, query, style, numberOfLines }: { text: string; query: string; style?: StyleProp<TextStyle>; numberOfLines?: number }) {
  const { colors } = useTheme();
  const q = query.trim();
  if (!q) return <Text style={style} numberOfLines={numberOfLines}>{text}</Text>;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {parts.map((p, i) =>
        p.toLowerCase() === q.toLowerCase() ? (
          <Text key={i} variant="bodyStrong" style={{ backgroundColor: colors.highlight }}>
            {p}
          </Text>
        ) : (
          p
        ),
      )}
    </Text>
  );
}

/** First-use tooltip per feature (FR-OB-002) with "Don't show again". */
export function TutorialTip({ id, title, text }: { id: string; title: string; text: string }) {
  const { settings, markTutorialSeen } = usePreferences();
  const { t } = useLocale();
  const [hidden, setHidden] = useState(false);
  if (!settings || !settings.tutorialsEnabled || settings.tutorialsSeen.includes(id) || hidden) return null;
  return (
    <Card style={styles.tip}>
      <Text variant="bodyStrong">
        {title}
      </Text>
      <Text variant="callout" color="secondary">{text}</Text>
      <View style={styles.tipActions}>
        <Button size="sm" kind="ghost" title={t("common.dontShowAgain")} onPress={() => void markTutorialSeen(id)} />
        <Button size="sm" kind="secondary" title={t("common.gotIt")} onPress={() => setHidden(true)} />
      </View>
    </Card>
  );
}

/** "?" help button for each feature (FR-OB-002 §4). */
export function HelpButton({ title, text, example }: { title: string; text: string; example?: string }) {
  const { colors } = useTheme();
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Chip small label="?" onPress={() => setOpen(true)} accessibilityLabel={t("common.help", { title })} />
      <Sheet visible={open} onClose={() => setOpen(false)} title={title}>
        <Text variant="body">{text}</Text>
        {example ? (
          <View style={[styles.example, { backgroundColor: colors.accentSoft }]}>
            <Text variant="label" color="secondary">
              {t("common.example")}
            </Text>
            <Text variant="body">{example}</Text>
          </View>
        ) : null}
        <Button title={t("common.close")} kind="secondary" onPress={() => setOpen(false)} />
      </Sheet>
    </>
  );
}

const light = palettes.light;
const font = (v: keyof typeof typeScale): TextStyle => {
  const { fontFamily, fontSize, lineHeight, letterSpacing } = typeScale[v];
  return { fontFamily, fontSize, lineHeight, letterSpacing };
};

/**
 * @deprecated Static light-theme styles for screens not yet migrated (docs/design.md migration log).
 * Migrated screens use primitives + useTheme() instead.
 */
export const ui = StyleSheet.create({
  screen: { flex: 1, backgroundColor: light.canvas },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: 120 },
  h1: { ...font("title1"), color: light.text },
  h2: { ...font("headline"), color: light.text },
  body: { ...font("body"), color: light.text },
  meta: { ...font("caption"), color: light.textSecondary },
  row: { flexDirection: "row", alignItems: "center" },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  input: {
    ...font("body"),
    minHeight: 48,
    borderWidth: 1,
    borderColor: light.hairline,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: light.surface,
    color: light.text,
  },
  label: { ...font("label"), color: light.textSecondary, marginBottom: 6 },
  error: { ...font("callout"), color: light.danger.fg },
});

const styles = StyleSheet.create({
  flexShrink: { flexShrink: 1 },
  sectionRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.md, marginTop: spacing.xs },
  track: { overflow: "hidden", width: "100%" },
  meter: { gap: spacing.xs },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  tip: { gap: 6 },
  tipActions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm },
  example: { borderRadius: radii.md, padding: spacing.md, gap: spacing.xs },
});
