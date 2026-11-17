import { useState } from "react";
import { StyleSheet, Text as RNText, View, type StyleProp, type ViewStyle } from "react-native";
import { useLocale } from "../i18n/LocaleProvider";
import { taskFormStyles } from "../screens/tasks/taskFormStyles";
import { useTheme } from "../theme/ThemeProvider";
import { parseYmd } from "../utils/pickers";
import { addDays, sameDay, startOfDay } from "../utils/timeline";
import { Icon } from "./icons/Icon";
import { DatePickerSheet, TimePickerSheet } from "./pickers/PickerSheets";
import { Chip, PressableScale, Text } from "./primitives";

/**
 * Date and time fields (UI v3). Same props as before, so every form gets the custom pickers
 * (components/pickers/PickerSheets.tsx) instead of the system dialogs: a field shows the value in words ("Today",
 * "Tue, 18 Nov", "9:00 AM") with an icon; a tap opens the sheet.
 */

/** "Today", "Tomorrow", or "Tue, 18 Nov". */
export function friendlyDate(ymd: string, t: (k: "picker.today" | "picker.tomorrow") => string): string {
  const d = parseYmd(ymd);
  if (!d) return ymd;
  const today = startOfDay(new Date());
  if (sameDay(d, today)) return t("picker.today");
  if (sameDay(d, addDays(today, 1))) return t("picker.tomorrow");
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function Field({ icon, value, placeholder, onPress, label, style }: { icon: "calendar" | "clock"; value: string; placeholder: string; onPress: () => void; label: string; style?: StyleProp<ViewStyle> }) {
  const { colors, radii } = useTheme();
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value || placeholder}`}
      style={[styles.field, { borderColor: colors.hairline, backgroundColor: colors.surface, borderRadius: radii.md }, style]}
      pressedStyle={{ backgroundColor: colors.accentSoft }}
    >
      <Icon name={icon} size={18} color={value ? colors.accentStrong : colors.textTertiary} />
      <Text variant="body" numberOfLines={1} style={[styles.flex, { color: value ? colors.text : colors.textTertiary }]}>
        {value || placeholder}
      </Text>
      <Icon name="chevronDown" size={16} color={colors.textTertiary} />
    </PressableScale>
  );
}

export function TaskFormDueDateRow({ valueYmd, onChangeYmd, onClear, label = "Due date" }: { valueYmd: string; onChangeYmd: (ymd: string) => void; onClear?: () => void; label?: string }) {
  const { t } = useLocale();
  const [show, setShow] = useState(false);
  return (
    <View style={taskFormStyles.field}>
      <RNText style={taskFormStyles.label}>{label}</RNText>
      <Field icon="calendar" label={label} value={valueYmd.trim() ? friendlyDate(valueYmd, t) : ""} placeholder={t("picker.chooseDate")} onPress={() => setShow(true)} />
      <DatePickerSheet visible={show} onClose={() => setShow(false)} ymd={valueYmd.trim()} onPick={onChangeYmd} onClear={onClear} title={label} />
    </View>
  );
}

export function TaskFormDueTimeRow({
  valueTime,
  onChangeTime,
  label = "Due time",
  quickTimes,
}: {
  valueTime: string;
  onChangeTime: (t: string) => void;
  /** Kept for callers; the custom picker doesn't need the day. */
  baseYmd?: string;
  label?: string;
  quickTimes?: readonly string[];
}) {
  const { t } = useLocale();
  const [show, setShow] = useState(false);
  return (
    <View style={taskFormStyles.field}>
      <RNText style={taskFormStyles.label}>{label}</RNText>
      <Field icon="clock" label={label} value={valueTime.trim()} placeholder={t("picker.chooseTime")} onPress={() => setShow(true)} />
      {quickTimes?.length ? (
        <View style={styles.quickRow}>
          {quickTimes.map((qt) => (
            <Chip key={qt} small label={qt} selected={qt === valueTime.trim()} onPress={() => onChangeTime(qt)} />
          ))}
        </View>
      ) : null}
      <TimePickerSheet visible={show} onClose={() => setShow(false)} time={valueTime} onPick={onChangeTime} title={label} />
    </View>
  );
}

/** Compact time-only control for chat / voice follow-ups. */
export function InlineTimePickerField({ value, onChange, placeholder, style }: { value: string; onChange: (t: string) => void; placeholder?: string; baseYmd?: string; style?: StyleProp<ViewStyle> }) {
  const { t } = useLocale();
  const [show, setShow] = useState(false);
  return (
    <View style={style}>
      <Field icon="clock" label={placeholder ?? t("picker.chooseTime")} value={value.trim()} placeholder={placeholder ?? t("picker.chooseTime")} onPress={() => setShow(true)} style={styles.inline} />
      <TimePickerSheet visible={show} onClose={() => setShow(false)} time={value} onPick={onChange} />
    </View>
  );
}

const styles = StyleSheet.create({
  field: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 52, paddingHorizontal: 14, borderWidth: 1 },
  inline: { minHeight: 44 },
  flex: { flex: 1 },
  quickRow: { marginTop: 8, flexDirection: "row", flexWrap: "wrap", gap: 6 },
});
