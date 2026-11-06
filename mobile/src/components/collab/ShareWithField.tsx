import { useEffect, useMemo, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { useLocale } from "../../i18n/LocaleProvider";
import { getCollabSummary, getConnections, type Person, type SharedKind } from "../../services/collabApi";
import { useTheme } from "../../theme/ThemeProvider";
import { activeMention, filterPeople, personLabel, withoutActiveMention } from "../../utils/collab";
import { Icon } from "../icons/Icon";
import { Button, Chip, IconButton, ListItem, Text } from "../ui";

export type ShareValue = { people: Person[]; kind: SharedKind };

/**
 * Task form → "Share with" (COLLAB_TASKS; renders nothing when the server has it off). Typing "@" lists the user's
 * connections, filtered as they type; a tap adds a chip. With someone picked: "Do it together" or "Only for them".
 */
export function ShareWithField({ value, onChange, onManage }: { value: ShareValue; onChange: (v: ShareValue) => void; onManage: () => void }) {
  const { t } = useLocale();
  const { colors, spacing, radii, type } = useTheme();
  const [available, setAvailable] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [text, setText] = useState("");

  useEffect(() => {
    let live = true;
    getCollabSummary()
      .then(async (s) => {
        if (!live || !s) return;
        setAvailable(true);
        const c = await getConnections();
        if (live) setPeople(c.connected.map((x) => x.user));
      })
      .catch(() => undefined); // offline or off: the form works without sharing
    return () => {
      live = false;
    };
  }, []);

  const query = activeMention(text);
  const picked = value.people.map((p) => p.id);
  const matches = useMemo(() => (query === null ? [] : filterPeople(people, query, picked)), [people, query, picked]);

  if (!available) return null;

  const pick = (p: Person) => {
    onChange({ ...value, people: [...value.people, p] });
    setText(withoutActiveMention(text));
  };

  return (
    <View style={{ gap: spacing.sm }}>
      <Text variant="label">{t("collab.share.label")}</Text>
      {value.people.length ? (
        <View style={[styles.wrap, { gap: spacing.xs }]}>
          {value.people.map((p) => (
            <View key={p.id} style={[styles.row, { gap: spacing.xs }]}>
              <Chip small label={personLabel(p)} leading={<Icon name="user" size={14} color={colors.accent} />} selected />
              <IconButton
                icon={<Icon name="close" size={16} color={colors.textSecondary} />}
                accessibilityLabel={t("collab.share.remove", { name: personLabel(p) })}
                onPress={() => onChange({ ...value, people: value.people.filter((x) => x.id !== p.id) })}
              />
            </View>
          ))}
        </View>
      ) : null}
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={t("collab.share.placeholder")}
        placeholderTextColor={colors.textTertiary}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={60}
        accessibilityLabel={t("collab.share.label")}
        style={[styles.input, type.body, { color: colors.text, borderColor: colors.hairline, borderRadius: radii.md, paddingHorizontal: spacing.md }]}
      />
      {query !== null ? (
        people.length === 0 ? (
          <View style={{ gap: spacing.xs }}>
            <Text variant="caption" color="secondary">
              {t("collab.share.noPeople")}
            </Text>
            <Button title={t("collab.share.manage")} kind="secondary" size="sm" onPress={onManage} style={styles.start} icon={<Icon name="people" size={16} color={colors.accent} />} />
          </View>
        ) : matches.length ? (
          <View style={[styles.list, { borderColor: colors.hairline, borderRadius: radii.md }]}>
            {matches.map((p) => (
              <ListItem
                key={p.id}
                title={personLabel(p)}
                subtitle={p.username && p.displayName ? p.displayName : undefined}
                leading={<Icon name="user" size={20} color={colors.textSecondary} />}
                onPress={() => pick(p)}
              />
            ))}
          </View>
        ) : (
          <Text variant="caption" color="secondary">
            {t("collab.share.noMatch", { q: query })}
          </Text>
        )
      ) : null}
      {value.people.length ? (
        <View style={{ gap: spacing.xs }}>
          <View style={[styles.wrap, { gap: spacing.xs }]}>
            <Chip label={t("collab.share.together")} selected={value.kind === "COLLAB"} onPress={() => onChange({ ...value, kind: "COLLAB" })} />
            <Chip label={t("collab.share.assign")} selected={value.kind === "ASSIGN"} onPress={() => onChange({ ...value, kind: "ASSIGN" })} />
          </View>
          <Text variant="caption" color="secondary">
            {t(value.kind === "COLLAB" ? "collab.share.togetherHint" : "collab.share.assignHint")}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
  row: { flexDirection: "row", alignItems: "center" },
  input: { borderWidth: StyleSheet.hairlineWidth, minHeight: 48 },
  list: { borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  start: { alignSelf: "flex-start" },
});
