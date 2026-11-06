import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import { TaskFormDueDateRow, TaskFormDueTimeRow } from "../../components/DueDateTimePickers";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Button, Card, Chip, ErrorState, Skeleton, Text } from "../../components/ui";
import { useLocale } from "../../i18n/LocaleProvider";
import type { StringKey } from "../../i18n/strings";
import type { MainStackParamList } from "../../navigation/MainStack";
import { apiErrorCode, isNetworkError } from "../../services/api";
import { acceptSharedTask, getSharedTask, updateSharedTask, type SharedTask } from "../../services/collabApi";
import { useTheme } from "../../theme/ThemeProvider";
import { collabErrorKey, personLabel } from "../../utils/collab";
import { dueDateAndTimeForSave, ymdFromLocalDate } from "../../utils/datetimeValidation";
import { formatDuration } from "../../utils/format";

type Props = NativeStackScreenProps<MainStackParamList, "SharedTaskEdit">;

const DURATIONS = [15, 30, 60, 90, 120, 180];
const QUICK_TIMES = ["9:00 AM", "2:00 PM", "4:00 PM", "7:00 PM", "9:00 PM"];

/**
 * Task collaboration. edit: the owner changes a shared task (a change to title, notes, date, time or length asks
 * everyone who accepted again). accept: a member accepts a card for their own date/time; the owner is told.
 */
export function SharedTaskEditScreen({ navigation, route }: Props) {
  const { id, mode } = route.params;
  const { t } = useLocale();
  const { colors, spacing, radii, type } = useTheme();
  const [shared, setShared] = useState<SharedTask | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [dueYmd, setDueYmd] = useState("");
  const [dueTime, setDueTime] = useState("");
  const [duration, setDuration] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await getSharedTask(id);
      setShared(s);
      setTitle(s.title);
      setNotes(s.description ?? "");
      setDueYmd(s.dueDate ? ymdFromLocalDate(new Date(s.dueDate)) : "");
      setDueTime(s.dueTime ?? "");
      setDuration(s.durationMinutes);
      setFailed(null);
    } catch (e) {
      setFailed(e);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (mode === "edit" && !title.trim()) return setError(t("collab.edit.titleRequired"));
    const { dueDateIso, dueTime: time } = dueDateAndTimeForSave({ pickerYmd: dueYmd, rawDueTime: dueTime });
    setSaving(true);
    setError(null);
    try {
      if (mode === "accept") await acceptSharedTask(id, { dueDate: dueDateIso, dueTime: time });
      else await updateSharedTask(id, { title: title.trim(), description: notes.trim() || null, dueDate: dueDateIso, dueTime: time, durationMinutes: duration });
      navigation.goBack();
    } catch (e) {
      setError(t(collabErrorKey(apiErrorCode(e), isNetworkError(e)) as StringKey));
    } finally {
      setSaving(false);
    }
  };

  const field = [styles.input, type.body, { color: colors.text, borderColor: colors.hairline, borderRadius: radii.md, paddingHorizontal: spacing.md, backgroundColor: colors.surface }];

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <ScreenHeader title={t(mode === "accept" ? "collab.edit.acceptTitle" : "collab.edit.title")} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxxl }} keyboardShouldPersistTaps="handled">
        {failed ? (
          <ErrorState error={failed} onRetry={() => void load()} />
        ) : !shared ? (
          [0, 1, 2].map((i) => <Skeleton key={i} height={56} />)
        ) : (
          <>
            <Card style={{ gap: spacing.md }}>
              {mode === "edit" ? (
                <>
                  <View style={{ gap: spacing.xs }}>
                    <Text variant="label">{t("collab.edit.titleLabel")}</Text>
                    <TextInput value={title} onChangeText={setTitle} maxLength={300} accessibilityLabel={t("collab.edit.titleLabel")} style={field} />
                  </View>
                  <View style={{ gap: spacing.xs }}>
                    <Text variant="label">{t("collab.edit.notes")}</Text>
                    <TextInput value={notes} onChangeText={setNotes} multiline maxLength={5000} accessibilityLabel={t("collab.edit.notes")} style={[field, styles.notes, { paddingTop: spacing.md }]} />
                  </View>
                </>
              ) : (
                <Text variant="headline">{shared.title}</Text>
              )}
              <TaskFormDueDateRow label={t("collab.edit.due")} valueYmd={dueYmd} onChangeYmd={setDueYmd} onClear={() => setDueYmd("")} />
              <TaskFormDueTimeRow label={t("collab.edit.time")} valueTime={dueTime} onChangeTime={setDueTime} baseYmd={dueYmd || undefined} quickTimes={QUICK_TIMES} />
              {mode === "edit" ? (
                <View style={{ gap: spacing.xs }}>
                  <Text variant="label">{t("collab.edit.duration")}</Text>
                  <View style={[styles.wrap, { gap: spacing.xs }]}>
                    {DURATIONS.map((m) => (
                      <Chip key={m} small label={formatDuration(m)} selected={duration === m} onPress={() => setDuration(duration === m ? null : m)} />
                    ))}
                  </View>
                </View>
              ) : null}
            </Card>
            <Text variant="caption" color="secondary">
              {mode === "accept" ? t("collab.edit.acceptHint", { name: personLabel(shared.owner) }) : t("collab.edit.saveHint")}
            </Text>
            {error ? (
              <Text variant="callout" color="danger">
                {error}
              </Text>
            ) : null}
            <Button title={t(mode === "accept" ? "collab.edit.acceptSave" : "collab.edit.save")} onPress={() => void save()} loading={saving} />
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: StyleSheet.hairlineWidth, minHeight: 48 },
  notes: { minHeight: 88, textAlignVertical: "top" },
  wrap: { flexDirection: "row", flexWrap: "wrap" },
});
