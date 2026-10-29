import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLocale } from "../i18n/LocaleProvider";
import { useTheme } from "../theme/ThemeProvider";
import { Icon } from "./icons/Icon";
import { Button, Card, PressableScale, Text } from "./ui";

/** Lines shown in "See what was read"; the text is the server's masked extraction (DOC_FALLBACK_UI). */
const MAX_LINES = 300;

/**
 * "See what was read" (DOC_FALLBACK_UI): the document's extracted text, line by line. With `empty` it is the
 * no-results screen ("I read this text but found no dates") with "Pick lines" and "Add manually". In pick mode
 * each line is a toggle; "Review N picked lines" hands them to `onPick`, which turns them into review items
 * (nothing is created here).
 */
export function DocumentTextView({ text, empty, busy, onPick, onAddManually }: { text: string; empty: boolean; busy?: boolean; onPick: (lines: string[]) => void; onAddManually: () => void }) {
  const { t } = useLocale();
  const { colors, spacing, radii } = useTheme();
  const lines = useMemo(() => text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, MAX_LINES), [text]);
  const [open, setOpen] = useState(empty);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const toggle = (i: number) => setPicked((p) => {
    const next = new Set(p);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    return next;
  });

  return (
    <Card tone={empty ? "warning" : undefined} style={{ gap: spacing.sm }}>
      {empty ? (
        <>
          <Text variant="headline">{t("docRoute.emptyTitle")}</Text>
          <Text variant="caption" color="secondary">{t("docRoute.emptyHint")}</Text>
        </>
      ) : (
        <Button kind="secondary" size="sm" icon={<Icon name="doc" size={16} color={colors.accent} />} title={t(open ? "docRoute.hideText" : "docRoute.seeText")} onPress={() => setOpen((o) => !o)} />
      )}
      {open ? (
        <>
          {picking ? <Text variant="caption" color="secondary">{t("docRoute.pickHelp")}</Text> : null}
          <View style={{ gap: spacing.xs }}>
            {lines.map((line, i) =>
              picking ? (
                <PressableScale
                  key={i}
                  onPress={() => toggle(i)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: picked.has(i) }}
                  accessibilityLabel={line}
                  style={[styles.line, { gap: spacing.sm, padding: spacing.xs, borderRadius: radii.sm, backgroundColor: picked.has(i) ? colors.accentSoft : "transparent" }]}
                >
                  <View style={[styles.box, { borderRadius: radii.sm / 2, borderColor: colors.accent, backgroundColor: picked.has(i) ? colors.accent : "transparent" }]}>
                    {picked.has(i) ? <Icon name="check" size={14} color={colors.onAccent} /> : null}
                  </View>
                  <Text variant="caption" style={styles.grow}>{line}</Text>
                </PressableScale>
              ) : (
                <Text key={i} variant="caption" color="secondary">{line}</Text>
              ),
            )}
          </View>
          <View style={[styles.row, { gap: spacing.sm }]}>
            {picking ? (
              <Button size="sm" title={t("docRoute.addPicked", { count: String(picked.size) })} disabled={!picked.size || busy} loading={busy} onPress={() => onPick([...picked].sort((a, b) => a - b).map((i) => lines[i]))} style={styles.grow} />
            ) : (
              <Button size="sm" kind="tonal" title={t("docRoute.pickLines")} onPress={() => setPicking(true)} style={styles.grow} />
            )}
            <Button size="sm" kind="secondary" title={t("docRoute.addManually")} onPress={onAddManually} style={styles.grow} />
          </View>
        </>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: "row", alignItems: "flex-start" },
  box: { width: 20, height: 20, borderWidth: 2, alignItems: "center", justifyContent: "center", marginTop: 2 },
  row: { flexDirection: "row" },
  grow: { flex: 1 },
});
