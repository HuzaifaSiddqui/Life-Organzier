import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLocale } from "../i18n/LocaleProvider";
import { useTheme } from "../theme/ThemeProvider";
import { fromInputValue, toInputValue } from "../utils/pickerInput";
import { Button, Dialog } from "./primitives";

/** Same shape as @react-native-community/datetimepicker's change event. */
export type DateTimePickerChangeEvent = { nativeEvent: { timestamp: number; utcOffset: number } };

type Props = {
  value: Date;
  mode?: "date" | "time";
  display?: string;
  themeVariant?: string;
  onValueChange?: (event: DateTimePickerChangeEvent, date: Date) => void;
  onDismiss?: () => void;
};

/**
 * Web / desktop build of DateTimePickerCompat: the browser's own date / time input in a dialog. Mounted when the
 * picker should show (the non-iOS path), like Android's dialog: Done reports the value, closing dismisses.
 */
export function DateTimePicker({ value, mode = "date", onValueChange, onDismiss }: Props) {
  const { t } = useLocale();
  const { colors, radii, spacing, type } = useTheme();
  const [draft, setDraft] = useState(() => toInputValue(value, mode));
  const done = () => {
    const picked = fromInputValue(draft, mode, value);
    if (!picked) return;
    onValueChange?.({ nativeEvent: { timestamp: picked.getTime(), utcOffset: -picked.getTimezoneOffset() } }, picked);
  };
  return (
    <Dialog visible onClose={() => onDismiss?.()}>
      <input
        type={mode}
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") done();
        }}
        style={{
          fontFamily: type.body.fontFamily,
          fontSize: type.body.fontSize,
          color: colors.text,
          backgroundColor: colors.surface,
          border: `1px solid ${colors.hairline}`,
          borderRadius: radii.md,
          padding: spacing.md,
          minHeight: 48,
        }}
      />
      <View style={[styles.actions, { gap: spacing.sm }]}>
        <Button title={t("common.cancel")} kind="secondary" size="sm" onPress={() => onDismiss?.()} />
        <Button title={t("common.ok")} size="sm" onPress={done} />
      </View>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", justifyContent: "flex-end" },
});
