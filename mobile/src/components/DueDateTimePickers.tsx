import DateTimePicker, { type DateTimePickerChangeEvent } from "@react-native-community/datetimepicker";
import { type ReactNode, useState } from "react";
import {
  type StyleProp,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import { colors, radii } from "../constants/theme";
import { TASK_FIELD_INPUT_HEIGHT, taskFormStyles } from "../screens/tasks/taskFormStyles";
import {
  combineYmdAndTimeStrings,
  formatDueTime12h,
  ymdFromLocalDate,
} from "../utils/datetimeValidation";

type PickerMode = "date" | "time";

function IosSheet({
  visible,
  onRequestClose,
  title,
  children,
}: {
  visible: boolean;
  onRequestClose: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onRequestClose}>
      <Pressable style={styles.backdrop} onPress={onRequestClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.sheetTitle}>{title}</Text>
          {children}
          <Pressable style={styles.doneBtn} onPress={onRequestClose}>
            <Text style={styles.doneBtnText}>Done</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export function TaskFormDueDateRow({
  valueYmd,
  onChangeYmd,
  onClear,
  label = "Due date",
}: {
  valueYmd: string;
  onChangeYmd: (ymd: string) => void;
  onClear?: () => void;
  label?: string;
}) {
  const [show, setShow] = useState(false);
  const current = valueYmd.trim()
    ? combineYmdAndTimeStrings(valueYmd, "12:00 PM")
    : new Date();

  const onPick = (_event: DateTimePickerChangeEvent, selected: Date) => {
    if (Platform.OS === "android") setShow(false);
    onChangeYmd(ymdFromLocalDate(selected));
  };

  const onDismiss = () => {
    if (Platform.OS === "android") setShow(false);
  };

  const display = valueYmd.trim() ? valueYmd : "Choose date";

  return (
    <View style={taskFormStyles.field}>
      <Text style={taskFormStyles.label}>{label}</Text>
      <Pressable
        onPress={() => setShow(true)}
        style={({ pressed }) => [styles.trigger, pressed && styles.triggerPressed]}
      >
        <Text style={[styles.triggerText, !valueYmd.trim() && styles.triggerPlaceholder]}>
          {display}
        </Text>
      </Pressable>
      {valueYmd.trim() && onClear ? (
        <Pressable onPress={onClear} style={styles.clearLinkWrap}>
          <Text style={styles.clearLink}>Clear date</Text>
        </Pressable>
      ) : null}
      {Platform.OS === "ios" ? (
        <IosSheet visible={show} onRequestClose={() => setShow(false)} title="Due date">
          <DateTimePicker
            value={current}
            mode="date"
            display="spinner"
            onValueChange={onPick}
            onDismiss={onDismiss}
            themeVariant="light"
          />
        </IosSheet>
      ) : (
        show ? (
          <DateTimePicker value={current} mode="date" display="default" onValueChange={onPick} onDismiss={onDismiss} />
        ) : null
      )}
    </View>
  );
}

export function TaskFormDueTimeRow({
  valueTime,
  onChangeTime,
  baseYmd,
  label = "Due time",
  quickTimes,
}: {
  valueTime: string;
  onChangeTime: (t: string) => void;
  /** Calendar day used when opening the time wheel (defaults to today). */
  baseYmd?: string;
  label?: string;
  quickTimes?: readonly string[];
}) {
  const [show, setShow] = useState(false);
  const seed = valueTime.trim() || "9:00 AM";
  const current = combineYmdAndTimeStrings(baseYmd, seed);

  const onPick = (_event: DateTimePickerChangeEvent, selected: Date) => {
    if (Platform.OS === "android") setShow(false);
    onChangeTime(formatDueTime12h(selected));
  };

  const onDismiss = () => {
    if (Platform.OS === "android") setShow(false);
  };

  const display = valueTime.trim() ? valueTime : "Choose time";

  return (
    <View style={taskFormStyles.field}>
      <Text style={taskFormStyles.label}>{label}</Text>
      <Pressable
        onPress={() => setShow(true)}
        style={({ pressed }) => [styles.trigger, pressed && styles.triggerPressed]}
      >
        <Text style={[styles.triggerText, !valueTime.trim() && styles.triggerPlaceholder]}>
          {display}
        </Text>
      </Pressable>
      {quickTimes?.length ? (
        <View style={styles.quickRow}>
          {quickTimes.map((qt) => (
            <Pressable key={qt} style={styles.quickChip} onPress={() => onChangeTime(qt)}>
              <Text style={styles.quickChipText}>{qt}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {Platform.OS === "ios" ? (
        <IosSheet visible={show} onRequestClose={() => setShow(false)} title="Due time">
          <DateTimePicker
            value={current}
            mode="time"
            display="spinner"
            onValueChange={onPick}
            onDismiss={onDismiss}
            themeVariant="light"
          />
        </IosSheet>
      ) : (
        show ? (
          <DateTimePicker value={current} mode="time" display="default" onValueChange={onPick} onDismiss={onDismiss} />
        ) : null
      )}
    </View>
  );
}

/** Compact time-only control for chat/voice follow-ups (uses today as the calendar day for the wheel). */
export function InlineTimePickerField({
  value,
  onChange,
  placeholder = "Choose time",
  baseYmd,
  style,
}: {
  value: string;
  onChange: (t: string) => void;
  placeholder?: string;
  /** Defaults to today's date when omitted. */
  baseYmd?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const [show, setShow] = useState(false);
  const seed = value.trim() || "9:00 AM";
  const current = combineYmdAndTimeStrings(baseYmd, seed);

  const onPick = (_event: DateTimePickerChangeEvent, selected: Date) => {
    if (Platform.OS === "android") setShow(false);
    onChange(formatDueTime12h(selected));
  };

  const onDismiss = () => {
    if (Platform.OS === "android") setShow(false);
  };

  return (
    <View style={style}>
      <Pressable
        onPress={() => setShow(true)}
        style={({ pressed }) => [styles.inlineTrigger, pressed && styles.triggerPressed]}
      >
        <Text style={[styles.triggerText, !value.trim() && styles.triggerPlaceholder]}>
          {value.trim() ? value : placeholder}
        </Text>
      </Pressable>
      {Platform.OS === "ios" ? (
        <IosSheet visible={show} onRequestClose={() => setShow(false)} title="Time">
          <DateTimePicker
            value={current}
            mode="time"
            display="spinner"
            onValueChange={onPick}
            onDismiss={onDismiss}
            themeVariant="light"
          />
        </IosSheet>
      ) : (
        show ? (
          <DateTimePicker value={current} mode="time" display="default" onValueChange={onPick} onDismiss={onDismiss} />
        ) : null
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(15, 18, 24, 0.40)",
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 28,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  sheetTitle: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: colors.text,
    marginBottom: 8,
    textAlign: "center",
  },
  doneBtn: {
    marginTop: 12,
    alignSelf: "center",
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: radii.md,
    backgroundColor: colors.primary,
  },
  doneBtnText: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
  },
  trigger: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: 16,
    height: TASK_FIELD_INPUT_HEIGHT,
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  triggerPressed: {
    opacity: 0.92,
  },
  triggerText: {
    fontSize: 16,
    color: colors.text,
  },
  triggerPlaceholder: {
    color: "#646A78",
  },
  quickRow: {
    marginTop: 8,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  quickChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: colors.surfaceSoft,
  },
  quickChipText: {
    fontSize: 11,
    color: colors.textMuted,
    fontFamily: "Inter_500Medium",
  },
  inlineTrigger: {
    height: 44,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    justifyContent: "center",
  },
  clearLinkWrap: {
    marginTop: 6,
    alignSelf: "flex-start",
  },
  clearLink: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: colors.primary,
  },
});
