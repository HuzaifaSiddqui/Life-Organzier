import { useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { useLocale } from "../i18n/LocaleProvider";
import type { StringKey } from "../i18n/strings";
import type { InstructionResult } from "../services/documentsApi";
import { useTheme } from "../theme/ThemeProvider";
import { Button, Card, Chip, Text } from "./ui";

/**
 * DOC_INSTRUCTIONS (server flag): what the user wants from a document. Shown only when the server reads requests.
 * Upload: an optional box with example chips. Review: what was understood, how many items it keeps, "Show everything"
 * and "Change request"; or the question first (which person, nobody by that name, words not understood).
 */
const EXAMPLES: Array<{ key: StringKey; text: string }> = [
  { key: "docInstr.example.person", text: "only Dr. " },
  { key: "docInstr.example.exams", text: "just the exams" },
  { key: "docInstr.example.days", text: "Mondays and Wednesdays" },
  { key: "docInstr.example.course", text: "only " },
];

function RequestBox({ value, onChange, disabled }: { value: string; onChange: (text: string) => void; disabled?: boolean }) {
  const { t } = useLocale();
  const { colors, spacing, radii, type } = useTheme();
  return (
    <View style={{ gap: spacing.xs }}>
      <Text variant="label">{t("docInstr.label")}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        editable={!disabled}
        placeholder={t("docInstr.placeholder")}
        placeholderTextColor={colors.textTertiary}
        maxLength={300}
        accessibilityLabel={t("docInstr.label")}
        style={[styles.input, type.body, { color: colors.text, borderColor: colors.hairline, borderRadius: radii.md, paddingHorizontal: spacing.md }]}
      />
      <View style={[styles.wrap, { gap: spacing.xs }]}>
        {EXAMPLES.map((e) => (
          <Chip key={e.key} small label={t(e.key)} onPress={disabled ? undefined : () => onChange(e.text)} />
        ))}
      </View>
    </View>
  );
}

/** The upload screen's optional request. */
export function InstructionInput(props: { value: string; onChange: (text: string) => void; disabled?: boolean }) {
  return <RequestBox {...props} />;
}

/** The review: the request as read, the question when it isn't settled, and the controls to change it. */
export function InstructionPanel({
  result,
  showAll,
  busy,
  onToggleShowAll,
  onChange,
}: {
  result: InstructionResult;
  showAll: boolean;
  busy?: boolean;
  onToggleShowAll: () => void;
  onChange: (instruction: string, person?: string) => void;
}) {
  const { t } = useLocale();
  const { spacing } = useTheme();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(result.instruction);
  const asked = result.status !== "applied";

  return (
    <Card tone={asked ? "warning" : undefined} style={{ gap: spacing.sm }}>
      {result.status === "applied" ? (
        <Text variant="body">{t("docInstr.filteredBy", { what: result.understood.join(" · "), shown: String(result.shown), total: String(result.total) })}</Text>
      ) : null}
      {result.status === "ask_person" ? (
        <>
          <Text variant="body">{t("docInstr.askPerson", { name: result.instruction })}</Text>
          <View style={[styles.wrap, { gap: spacing.xs }]}>
            {(result.options ?? []).map((p) => (
              <Chip key={p} label={p} onPress={busy ? undefined : () => onChange(result.instruction, p)} />
            ))}
          </View>
        </>
      ) : null}
      {result.status === "no_person" ? (
        <>
          <Text variant="body">{t("docInstr.noPerson", { name: result.instruction })}</Text>
          {result.nearest?.length ? (
            <>
              <Text variant="caption" color="secondary">{t("docInstr.nearest")}</Text>
              <View style={[styles.wrap, { gap: spacing.xs }]}>
                {result.nearest.map((p) => (
                  <Chip key={p} label={p} onPress={busy ? undefined : () => onChange(result.instruction, p)} />
                ))}
              </View>
            </>
          ) : null}
        </>
      ) : null}
      {result.status === "not_understood" ? (
        <Text variant="body">
          {t("docInstr.notUnderstood", { understood: result.understood.join(", ") || t("docInstr.understoodNothing"), leftover: (result.leftover ?? []).join(", ") })}
        </Text>
      ) : null}
      {asked ? <Text variant="caption" color="secondary">{t("docInstr.nothingCreated")}</Text> : null}

      {editing ? (
        <View style={{ gap: spacing.sm }}>
          <RequestBox value={draft} onChange={setDraft} disabled={busy} />
          <View style={[styles.row, { gap: spacing.sm }]}>
            <Button size="sm" title={t("docInstr.apply")} loading={busy} disabled={busy} onPress={() => { setEditing(false); onChange(draft); }} />
            <Button size="sm" kind="ghost" title={t("docInstr.cancel")} disabled={busy} onPress={() => { setEditing(false); setDraft(result.instruction); }} />
          </View>
        </View>
      ) : (
        <View style={[styles.wrap, { gap: spacing.sm }]}>
          {result.status === "applied" ? <Button size="sm" kind="secondary" title={t(showAll ? "docInstr.showFiltered" : "docInstr.showAll")} onPress={onToggleShowAll} /> : null}
          <Button size="sm" kind="secondary" title={t("docInstr.change")} disabled={busy} onPress={() => setEditing(true)} />
          {asked ? <Button size="sm" kind="ghost" title={t("docInstr.clear")} disabled={busy} onPress={() => onChange("")} /> : null}
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: StyleSheet.hairlineWidth, minHeight: 44 },
  wrap: { flexDirection: "row", flexWrap: "wrap" },
  row: { flexDirection: "row" },
});
