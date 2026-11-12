import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useLocale } from "../../i18n/LocaleProvider";
import { getCollabSummary, getConnections, type Person } from "../../services/collabApi";
import { useTheme } from "../../theme/ThemeProvider";
import { activeMention, filterPeople, insertMention, personLabel } from "../../utils/collab";
import { Icon } from "../icons/Icon";
import { ListItem, Text } from "../ui";

/**
 * Chat input (COLLAB_TASKS): typing "@" lists the user's accepted connections, filtered as they type; a tap inserts
 * the mention. The message then goes to the assistant as usual, which proposes sharing (Together / Only for them /
 * Just me); nothing reaches anyone before that answer. Renders nothing while the feature is off or no "@" is typed.
 */
export function MentionPicker({ text, onPick }: { text: string; onPick: (next: string) => void }) {
  const { t } = useLocale();
  const { colors, spacing, radii } = useTheme();
  const [people, setPeople] = useState<Person[] | null>(null);
  const query = activeMention(text);

  useEffect(() => {
    if (query === null || people !== null) return;
    let live = true;
    void (async () => {
      try {
        if (!(await getCollabSummary())) return live && setPeople([]);
        const c = await getConnections();
        if (live) setPeople(c.connected.map((x) => x.user));
      } catch {
        if (live) setPeople([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [query, people]);

  const matches = useMemo(() => (query === null || !people ? [] : filterPeople(people, query, [], 5)), [people, query]);
  if (query === null || !people?.length) return null;

  return (
    <View style={[styles.box, { backgroundColor: colors.surface, borderColor: colors.hairline, borderRadius: radii.md, marginBottom: spacing.xs }]}>
      <Text variant="label" color="secondary" style={{ paddingHorizontal: spacing.md, paddingTop: spacing.sm }}>
        {t("collab.mention.title")}
      </Text>
      {matches.length ? (
        <ScrollView keyboardShouldPersistTaps="always" style={styles.list}>
          {matches.map((p) => (
            <ListItem
              key={p.id}
              title={personLabel(p)}
              subtitle={p.username && p.displayName ? p.displayName : undefined}
              leading={<Icon name="user" size={20} color={colors.textSecondary} />}
              onPress={() => onPick(insertMention(text, p))}
            />
          ))}
        </ScrollView>
      ) : (
        <Text variant="caption" color="secondary" style={{ padding: spacing.md }}>
          {t("collab.mention.none", { q: query })}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  list: { maxHeight: 220 },
});
