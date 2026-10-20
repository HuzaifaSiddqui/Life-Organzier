import DateTimePicker, { type DateTimePickerChangeEvent } from "@react-native-community/datetimepicker";
import { useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { useLocale } from "../i18n/LocaleProvider";
import type { StringKey } from "../i18n/strings";
import { useTheme } from "../theme/ThemeProvider";
import { combineYmdAndTimeStrings, ymdFromLocalDate } from "../utils/datetimeValidation";
import { Icon } from "./icons/Icon";
import { Button, Sheet, Text } from "./ui";

export type ReviewFlags = {
  assumedTime: boolean;
  needsSemesterStart?: boolean;
  aiOnly?: boolean;
  rangeStart?: string | null;
  yearInferred?: boolean;
};

/** "h:mm AM" (the format the server reads), independent of the phone's locale. */
function clock12(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

/**
 * One extracted deadline's review details (FR-DP-002): why it needs a look (time assumed, no semester start,
 * found only by AI), the words it came from, and one-tap date / time pickers. Nothing is created from here;
 * the screen's "Create selected" does that after the user has checked.
 */
export function DeadlineReviewItem({
  date,
  time,
  source,
  flags,
  disabled,
  onChangeDate,
  onChangeTime,
}: {
  date: string;
  time: string;
  source: string;
  flags: ReviewFlags;
  disabled?: boolean;
  onChangeDate: (ymd: string) => void;
  onChangeTime: (time: string) => void;
}) {
  const { t } = useLocale();
  const { colors, spacing, radii } = useTheme();
  const [picking, setPicking] = useState<"date" | "time" | null>(null);
  const value = combineYmdAndTimeStrings(date || undefined, time || "11:59 PM");

  const onPick = (_e: DateTimePickerChangeEvent, selected: Date) => {
    if (Platform.OS === "android") setPicking(null);
    if (picking === "date") onChangeDate(ymdFromLocalDate(selected));
    else onChangeTime(clock12(selected));
  };

  const notes: Array<{ key: StringKey; vars?: Record<string, string>; tone: "warning" | "info" }> = [];
  if (!date) notes.push({ key: flags.needsSemesterStart ? "docReview.needsSemesterStart" : "docReview.noDate", tone: "warning" });
  if (date && flags.assumedTime) notes.push({ key: "docReview.assumedTime", tone: "warning" });
  if (flags.aiOnly) notes.push({ key: "docReview.aiOnly", tone: "info" });
  if (flags.rangeStart) notes.push({ key: "docReview.range", vars: { start: flags.rangeStart }, tone: "info" });
  if (flags.yearInferred) notes.push({ key: "docReview.yearInferred", tone: "info" });

  const picker = picking ? (
    <DateTimePicker value={value} mode={picking} display={Platform.OS === "ios" ? (picking === "date" ? "inline" : "spinner") : "default"} onValueChange={onPick} onDismiss={() => setPicking(null)} />
  ) : null;

  return (
    <View style={{ gap: spacing.sm }}>
      {notes.map((n) => (
        <View key={n.key} style={[styles.note, { backgroundColor: colors[n.tone].bg, borderRadius: radii.sm, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs }]}>
          <Icon name={n.tone === "warning" ? "clock" : "info"} size={16} color={colors[n.tone].fg} />
          <Text variant="caption" color={n.tone} style={styles.noteText}>
            {t(n.key, n.vars)}
          </Text>
        </View>
      ))}
      <View style={styles.row}>
        <Button
          kind="secondary"
          size="sm"
          icon={<Icon name="calendar" size={16} color={colors.accent} />}
          title={date || t("docReview.pickDate")}
          accessibilityLabel={`${t("docReview.date")}: ${date || t("docReview.pickDate")}`}
          disabled={disabled}
          onPress={() => setPicking("date")}
          style={styles.grow}
        />
        <Button
          kind="secondary"
          size="sm"
          icon={<Icon name="clock" size={16} color={colors.accent} />}
          title={time || t("docReview.pickTime")}
          accessibilityLabel={`${t("docReview.time")}: ${time || t("docReview.pickTime")}`}
          disabled={disabled}
          onPress={() => setPicking("time")}
          style={styles.grow}
        />
      </View>
      {source ? (
        <Text variant="caption" color="secondary" numberOfLines={3}>
          {t("docReview.from", { text: source.length > 160 ? `${source.slice(0, 157)}…` : source })}
        </Text>
      ) : null}
      {Platform.OS === "ios" ? (
        <Sheet visible={picking !== null} onClose={() => setPicking(null)} title={t(picking === "time" ? "docReview.time" : "docReview.date")}>
          {picker}
          <Button title={t("docReview.done")} onPress={() => setPicking(null)} />
        </Sheet>
      ) : (
        picker
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8 },
  grow: { flex: 1 },
  note: { flexDirection: "row", alignItems: "center", gap: 6 },
  noteText: { flex: 1 },
});
