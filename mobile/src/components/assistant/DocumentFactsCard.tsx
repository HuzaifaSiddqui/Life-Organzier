import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useLocale } from "../../i18n/LocaleProvider";
import { keepDocumentFacts } from "../../services/documentsApi";
import { useTheme } from "../../theme/ThemeProvider";
import type { DocumentFactsChatCard } from "../../types/models";
import { Icon } from "../icons/Icon";
import { Button, Card, Text } from "../ui";

/**
 * DOC_KNOWLEDGE: facts about the user proposed from a document they sent. Nothing is remembered until the user ticks
 * facts and taps "Keep selected" (CLAUDE.md: AI-proposed data is never trusted blindly). After that the card shows what
 * was kept; the facts are in Me → What I know.
 */
export function DocumentFactsCard({ card }: { card: DocumentFactsChatCard }) {
  const { t } = useLocale();
  const { colors, spacing, radii } = useTheme();
  const [ticked, setTicked] = useState<string[]>(() => card.facts.map((f) => f.id));
  const [kept, setKept] = useState<string[] | null>(card.kept ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) => setTicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  const keep = async () => {
    setBusy(true);
    setError(null);
    try {
      await keepDocumentFacts(card.documentId, ticked);
      setKept(ticked);
    } catch {
      setError(t("docFacts.failed"));
    } finally {
      setBusy(false);
    }
  };

  if (kept) {
    return (
      <Card style={{ gap: spacing.xs }}>
        <Text variant="bodyStrong">{kept.length ? t("docFacts.kept", { count: String(kept.length) }) : t("docFacts.keptNone")}</Text>
        {card.facts
          .filter((f) => kept.includes(f.id))
          .map((f) => (
            <View key={f.id} style={[styles.row, { gap: spacing.sm }]}>
              <Icon name="check" size={16} color={colors.success.fg} />
              <Text variant="callout" style={styles.flex}>
                {pretty(f.content)}
              </Text>
            </View>
          ))}
      </Card>
    );
  }

  return (
    <Card style={{ gap: spacing.sm }}>
      <View accessibilityRole="list" style={{ gap: spacing.xs }}>
        {card.facts.map((f) => {
          const on = ticked.includes(f.id);
          return (
            <Pressable
              key={f.id}
              onPress={() => toggle(f.id)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              style={[styles.row, { gap: spacing.md, minHeight: 44 }]}
            >
              <View style={[styles.box, { borderColor: on ? colors.accent : colors.hairline, backgroundColor: on ? colors.accent : "transparent", borderRadius: radii.sm }]}>
                {on ? <Icon name="check" size={14} color={colors.onAccent} /> : null}
              </View>
              <Text variant="callout" style={styles.flex}>
                {pretty(f.content)}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {error ? (
        <Text variant="caption" color="danger">
          {error}
        </Text>
      ) : null}
      <View style={[styles.row, { gap: spacing.sm }]}>
        <Button title={t("docFacts.keep", { count: String(ticked.length) })} size="sm" disabled={!ticked.length} loading={busy} onPress={() => void keep()} />
        <Button title={t("docFacts.none")} size="sm" kind="ghost" disabled={busy} onPress={() => { setTicked([]); void keepDocumentFacts(card.documentId, []).then(() => setKept([]), () => setError(t("docFacts.failed"))); }} />
      </View>
    </Card>
  );
}

/** "User studies BSE at …" → "You study BSE at …" is too clever for every phrasing; just drop the leading "User". */
function pretty(content: string): string {
  const s = content.replace(/^user('s)?\s+/i, (_m, poss: string | undefined) => (poss ? "Your " : ""));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  flex: { flex: 1 },
  box: { width: 24, height: 24, borderWidth: 2, alignItems: "center", justifyContent: "center" },
});
