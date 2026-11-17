import { OutboxRefused, send, type SendInput } from "../../services/outbox";
import { readCache, writeCache } from "../../services/localCache";
import { scheduleReminderSync } from "../../services/reminders";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { InlineTimePickerField, TaskFormDueDateRow } from "../../components/DueDateTimePickers";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Button, Card, Chip, EmptyState, HelpButton, KeyboardPad, ProgressBar, SectionTitle, Snackbar, TutorialTip, ui } from "../../components/ui";
import { useLocale } from "../../i18n/LocaleProvider";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../theme/ThemeProvider";
import { Icon } from "../../components/icons/Icon";
import { IconButton, PressableScale, Text as PText } from "../../components/primitives";
import { colors, palette } from "../../constants/theme";
import { usePreferences } from "../../context/PreferencesContext";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getApiErrorMessage, isNetworkError } from "../../services/api";
import {
  getRoutines,
  getTodayOccurrences,
  type RoutineInput,
} from "../../services/routinesApi";
import type { Routine, RoutineFrequency, RoutineOccurrence, RoutinePriority } from "../../types/models";
import { ymdFromLocalDate } from "../../utils/datetimeValidation";
import { formatDuration, WEEKDAYS_SHORT } from "../../utils/format";
import { INTERVAL_CHOICES, intervalRepeatLabel } from "../../utils/routineRepeat";
import { showAlert } from "../../services/dialog";

type Props = NativeStackScreenProps<MainStackParamList, "Routines">;

const FREQS: Array<{ key: RoutineFrequency; label: string }> = [
  { key: "DAILY", label: "Daily" },
  { key: "WEEKLY", label: "Weekly" },
  { key: "MONTHLY", label: "Monthly" },
  { key: "CUSTOM", label: "Custom days" },
];
const PRIORITIES: Array<{ key: RoutinePriority; label: string; hint: string }> = [
  { key: "MANDATORY", label: "Mandatory", hint: "scheduled first; skipping needs confirmation" },
  { key: "IMPORTANT", label: "Important", hint: "kept at its preferred time" },
  { key: "NORMAL", label: "Normal", hint: "can be skipped on busy days" },
];
const CATEGORIES = ["Health", "Work", "Personal", "Learning", "Admin"];

type FormState = RoutineInput & { id?: string };

const EMPTY: FormState = {
  title: "",
  frequency: "DAILY",
  daysOfWeek: [new Date().getDay()],
  dayOfMonth: new Date().getDate(),
  dueTime: null,
  durationMinutes: null,
  category: null,
  priority: "NORMAL",
  timeLocked: false,
  locationContext: null,
  noReminder: false,
};

function formFor(r: Routine): FormState {
  return { ...EMPTY, ...r, id: r.id, daysOfWeek: r.daysOfWeek ?? [], dayOfMonth: r.dayOfMonth ?? 1, noReminder: !r.dueTime };
}

function freqLabel(r: Routine): string {
  if (r.intervalDays && r.anchorDate) return intervalRepeatLabel(r.intervalDays, r.anchorDate);
  if (r.frequency === "DAILY") return "Every day";
  if (r.frequency === "MONTHLY") return `Monthly on day ${r.dayOfMonth}`;
  const days = (r.daysOfWeek ?? []).map((d) => WEEKDAYS_SHORT[d]).join(", ");
  return days ? `Every ${days}` : "Weekly";
}

function adherence(r: Routine): { pct: number; total: number } | null {
  const now = Date.now();
  const past = r.occurrences.filter((o) => Date.parse(o.occurrenceDate) < now && o.status !== "PENDING");
  if (past.length < 2) return null;
  return { pct: Math.round((past.filter((o) => o.status === "COMPLETED").length / past.length) * 100), total: past.length };
}

export function RoutineScreen({ navigation, route }: Props) {
  const { t } = useLocale();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { settings } = usePreferences();
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [today, setToday] = useState<Array<RoutineOccurrence & { routine: Routine }>>([]);
  const [showAll, setShowAll] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const cacheKey = `routines:${showAll ? "all" : "active"}`;

  // The saved copy first (also offline); the server's copy replaces it when it arrives.
  useEffect(() => {
    let live = true;
    void readCache<{ routines: Routine[]; today: Array<RoutineOccurrence & { routine: Routine }> }>(cacheKey).then((saved) => {
      if (!live || !saved) return;
      setRoutines(saved.routines);
      setToday(saved.today);
    });
    return () => {
      live = false;
    };
  }, [cacheKey]);

  const load = useCallback(async () => {
    try {
      const [r, t] = await Promise.all([getRoutines(showAll), getTodayOccurrences()]);
      setRoutines(r.routines);
      setToday(t);
      void writeCache(cacheKey, { routines: r.routines, today: t });
      // Opened for one routine (tapped in chat): show it, once.
      const openId = route.params?.routineId;
      if (openId) {
        navigation.setParams({ routineId: undefined });
        const r1 = r.routines.find((x) => x.id === openId) ?? (showAll ? undefined : (await getRoutines(true)).routines.find((x) => x.id === openId));
        if (r1) setForm(formFor(r1));
        else setToast("That routine no longer exists");
      }
    } catch (e) {
      // Offline: the saved copy stays on screen.
      if (!isNetworkError(e)) setToast(getApiErrorMessage(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAll, route.params?.routineId]);

  /** Sends a routine change (now, or when back online); a refusal reloads the server's copy and says why. */
  const sendChange = async (input: SendInput, done?: string) => {
    if (done) setToast(done);
    try {
      const sent = await send(input);
      scheduleReminderSync();
      if (sent) void load();
    } catch (e) {
      if (!(e instanceof OutboxRefused)) throw e;
      setToast(e.message);
      void load();
    }
  };

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const setOccurrence = async (o: RoutineOccurrence & { routine: Routine }, status: "COMPLETED" | "SKIPPED", confirm = false) => {
    // Asked here (same rule as the server) so skipping works offline too.
    if (status === "SKIPPED" && o.routine.priority === "MANDATORY" && !confirm) {
      showAlert("Mandatory routine", `"${o.routine.title}" is mandatory. Are you sure you want to skip it?`, [
        { text: "Keep it", style: "cancel" },
        { text: "Skip anyway", style: "destructive", onPress: () => void setOccurrence(o, status, true) },
      ]);
      return;
    }
    setToday((list) => list.map((x) => (x.id === o.id ? { ...x, status } : x)));
    await sendChange(
      { method: "PATCH", path: `/routines/occurrences/${o.id}`, body: { status, confirmMandatory: confirm }, key: `occurrence:${o.id}`, label: "Routine" },
      status === "COMPLETED" ? `${o.routine.title} done` : `Skipped ${o.routine.title}`,
    );
  };

  const save = async () => {
    if (!form) return;
    if (!form.title.trim()) {
      setFormError("Give the routine a name");
      return;
    }
    if (!form.intervalDays && (form.frequency === "WEEKLY" || form.frequency === "CUSTOM") && !form.daysOfWeek?.length) {
      setFormError("Pick at least one day");
      return;
    }
    setSaving(true);
    setFormError(null);
    const payload: RoutineInput = {
      title: form.title.trim(),
      frequency: form.frequency,
      daysOfWeek: !form.intervalDays && (form.frequency === "WEEKLY" || form.frequency === "CUSTOM") ? form.daysOfWeek : null,
      dayOfMonth: !form.intervalDays && form.frequency === "MONTHLY" ? form.dayOfMonth : null,
      // Every N days: the server decides which days count (no day rule on the phone).
      intervalDays: form.intervalDays ?? null,
      anchorDate: form.intervalDays ? (form.anchorDate ?? ymdFromLocalDate(new Date())) : null,
      dueTime: form.noReminder ? null : form.dueTime || null,
      // Reminder on with no time: the server sets the user's usual time (9 AM until it is learned).
      noReminder: Boolean(form.noReminder),
      durationMinutes: form.durationMinutes,
      category: form.category,
      priority: form.priority,
      timeLocked: Boolean(form.dueTime) && form.timeLocked,
      locationContext: form.locationContext,
    };
    // Shown in the list at once; the server fills in the days and times when it answers (now or when online).
    const id = form.id;
    if (id) setRoutines((list) => list.map((r) => (r.id === id ? { ...r, ...payload, daysOfWeek: payload.daysOfWeek ?? null, dayOfMonth: payload.dayOfMonth ?? null } : r)));
    else setRoutines((list) => [...list, { ...payload, id: `local-${Date.now()}`, description: null, daysOfWeek: payload.daysOfWeek ?? null, dayOfMonth: payload.dayOfMonth ?? null, dueTime: payload.dueTime ?? null, durationMinutes: payload.durationMinutes ?? null, category: payload.category ?? null, locationContext: payload.locationContext ?? null, active: true, occurrences: [] }]);
    setForm(null);
    setSaving(false);
    await sendChange(
      id ? { method: "PUT", path: `/routines/${id}`, body: payload, key: `routine:${id}`, merge: true, label: "Routine" } : { method: "POST", path: "/routines", body: payload, label: "Routine" },
      id ? "Routine updated" : `Created ${payload.title}`,
    );
  };

  const contexts = settings?.contexts ?? [];

  const leadColor = (pct: number) => (pct >= 80 ? theme.colors.success.fg : pct >= 50 ? theme.colors.warning.fg : theme.colors.danger.fg);

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.canvas, paddingTop: insets.top }]}>
      {/* UI v3 list (docs/design.md "Routines"); the form below keeps its v2 layout. */}
      <View style={styles.topBar}>
        <IconButton icon={<Icon name="back" size={22} color={theme.colors.text} />} onPress={() => navigation.goBack()} accessibilityLabel={t("common.back")} />
        <PText variant="title1" style={styles.flex}>
          {t("routines.title")}
        </PText>
        <HelpButton title="Routines" text="Recurring activities. Time-locked routines (prayer, morning walk) are never moved — if missed, the next one is ready. Flexible ones (dentist, bills) can be rescheduled. Mandatory routines are scheduled first." example={'Tell the assistant: "Mandatory daily prayer at 5 AM"'} />
        <Button title={t("routines.add")} size="sm" icon={<Icon name="plus" size={16} color={theme.colors.onAccent} />} onPress={() => setForm({ ...EMPTY })} accessibilityLabel="Add routine" />
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 48 }]}>
        <TutorialTip id="routines" title="Create recurring activities here" text="Try “Daily meditation at 6 AM for 10 minutes” in the assistant, or tap Add." />
        <View style={styles.sectionHead}>
          <PText variant="label" color="tertiary">
            {t("routines.today").toUpperCase()}
          </PText>
          {settings?.currentContext ? (
            <PText variant="caption" color="tertiary">
              {settings.currentContext}
            </PText>
          ) : null}
        </View>
        {today.length ? (
          <Card style={styles.listCard}>
            {today.map((o, i) => {
              const done = o.status === "COMPLETED";
              const pending = o.status === "PENDING";
              return (
                <View key={o.id} style={[styles.occRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.hairline }]}>
                  <Pressable
                    onPress={() => (pending ? void setOccurrence(o, "COMPLETED") : undefined)}
                    hitSlop={11}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: done, disabled: !pending }}
                    accessibilityLabel={t(done ? "today.untick" : "today.tick", { title: o.routine.title })}
                    style={[styles.tick, { borderColor: done ? theme.colors.success.fg : theme.colors.textTertiary, backgroundColor: done ? theme.colors.success.fg : "transparent" }]}
                  >
                    {done ? <Icon name="check" size={15} color={theme.colors.onAccent} strokeWidth={2.4} /> : null}
                  </Pressable>
                  <View style={styles.flex}>
                    <PText variant="bodyStrong" style={!pending ? { color: theme.colors.textTertiary, textDecorationLine: done ? "line-through" : "none" } : undefined}>
                      {o.routine.title}
                    </PText>
                    <View style={styles.metaRow}>
                      {o.routine.timeLocked ? <Icon name="lock" size={12} color={theme.colors.textTertiary} /> : null}
                      <PText variant="caption" color="secondary">
                        {[o.dueTime ?? t("routines.anyTime"), o.routine.durationMinutes ? formatDuration(o.routine.durationMinutes) : null, !pending && !done ? o.status.toLowerCase() : null].filter(Boolean).join(" · ")}
                      </PText>
                    </View>
                  </View>
                  {pending ? <Button title={t("routines.skip")} size="sm" kind="ghost" onPress={() => void setOccurrence(o, "SKIPPED")} /> : null}
                </View>
              );
            })}
          </Card>
        ) : (
          <PText variant="callout" color="secondary">
            {t("routines.noneToday")}
          </PText>
        )}

        <View style={[styles.sectionHead, { marginTop: theme.spacing.xl }]}>
          <PText variant="label" color="tertiary">
            {t("routines.all").toUpperCase()}
          </PText>
          {contexts.length ? <Chip small label={showAll ? t("routines.allPlaces") : t("routines.thisPlace")} onPress={() => setShowAll((v) => !v)} /> : null}
        </View>
        {routines.length === 0 ? (
          <EmptyState title={t("empty.routines.title")} text={t("empty.routines.text")} action={<Button title={t("empty.routines.add")} size="sm" onPress={() => setForm({ ...EMPTY })} />} />
        ) : (
          <View style={{ gap: theme.spacing.md }}>
            {routines.map((r) => {
              const a = adherence(r);
              return (
                <PressableScale
                  key={r.id}
                  onPress={() => setForm(formFor(r))}
                  accessibilityRole="button"
                  accessibilityLabel={`${r.title}, ${freqLabel(r)}`}
                  style={[styles.routineCard, { backgroundColor: theme.colors.surface, borderColor: theme.colors.hairline, borderRadius: theme.radii.lg, opacity: r.active ? 1 : 0.55 }]}
                >
                  <View style={[styles.routineIcon, { backgroundColor: theme.colors.accentSoft, borderRadius: theme.radii.md }]}>
                    <Icon name={r.timeLocked ? "lock" : "repeat"} size={18} color={theme.colors.accentStrong} />
                  </View>
                  <View style={[styles.flex, { gap: 3 }]}>
                    <PText variant="bodyStrong" numberOfLines={1}>
                      {r.title}
                    </PText>
                    <PText variant="caption" color="secondary" numberOfLines={2}>
                      {[freqLabel(r), r.dueTime ?? t("routines.noReminder"), r.durationMinutes ? formatDuration(r.durationMinutes) : null, r.locationContext].filter(Boolean).join(" · ")}
                    </PText>
                    {a ? (
                      <View style={{ gap: 3, marginTop: 4 }}>
                        <View style={[styles.bar, { backgroundColor: theme.colors.chartGrid }]}>
                          <View style={{ width: `${a.pct}%`, height: "100%", backgroundColor: leadColor(a.pct), borderRadius: 2 }} />
                        </View>
                        <PText variant="caption" color="tertiary">
                          {t("routines.kept", { pct: a.pct, total: a.total })}
                          {a.pct >= 90 && a.total >= 7 ? ` · ${t("routines.reliable")}` : ""}
                        </PText>
                      </View>
                    ) : null}
                  </View>
                  <Switch
                    value={r.active}
                    accessibilityLabel={t(r.active ? "routines.on" : "routines.off", { title: r.title })}
                    onValueChange={(active) => {
                      setRoutines((list) => list.map((x) => (x.id === r.id ? { ...x, active } : x)));
                      void sendChange({ method: "PUT", path: `/routines/${r.id}`, body: { active }, key: `routine:${r.id}`, merge: true, label: "Routine" });
                    }}
                  />
                </PressableScale>
              );
            })}
          </View>
        )}
      </ScrollView>

      <Modal visible={Boolean(form)} animationType="slide" onRequestClose={() => setForm(null)}>
        {form ? (
          <KeyboardPad style={ui.screen}>
            <ScreenHeader title={form.id ? "Edit routine" : "New routine"} onBack={() => setForm(null)} />
            <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
              <Card style={{ gap: 14 }}>
                <View>
                  <Text style={ui.label}>Name</Text>
                  <TextInput style={ui.input} value={form.title} onChangeText={(title) => setForm({ ...form, title })} placeholder="e.g. Morning walk" placeholderTextColor={palette.muted} />
                </View>
                <View>
                  <Text style={ui.label}>How often?</Text>
                  <View style={ui.wrap}>
                    {FREQS.map((f) => (
                      <Chip key={f.key} small label={f.label} selected={!form.intervalDays && form.frequency === f.key} onPress={() => setForm({ ...form, frequency: f.key, intervalDays: null, anchorDate: null })} />
                    ))}
                    <Chip
                      small
                      label="Every few days"
                      selected={Boolean(form.intervalDays)}
                      onPress={() => setForm({ ...form, frequency: "DAILY", intervalDays: form.intervalDays ?? 2, anchorDate: form.anchorDate ?? ymdFromLocalDate(new Date()) })}
                    />
                  </View>
                </View>
                {form.intervalDays ? (
                  <View style={{ gap: 8 }}>
                    <Text style={ui.label}>Repeat every</Text>
                    <View style={ui.wrap}>
                      {INTERVAL_CHOICES.map((n) => (
                        <Chip key={n} small label={`${n} days`} selected={form.intervalDays === n} onPress={() => setForm({ ...form, intervalDays: n })} />
                      ))}
                    </View>
                    <TaskFormDueDateRow
                      label="Starting"
                      valueYmd={form.anchorDate ?? ymdFromLocalDate(new Date())}
                      onChangeYmd={(anchorDate) => setForm({ ...form, anchorDate })}
                      onClear={() => setForm({ ...form, anchorDate: ymdFromLocalDate(new Date()) })}
                    />
                    <Text style={ui.meta}>{intervalRepeatLabel(form.intervalDays, form.anchorDate ?? ymdFromLocalDate(new Date()))}</Text>
                  </View>
                ) : null}
                {!form.intervalDays && (form.frequency === "WEEKLY" || form.frequency === "CUSTOM") ? (
                  <View style={ui.wrap}>
                    {WEEKDAYS_SHORT.map((d, i) => {
                      const sel = form.daysOfWeek?.includes(i) ?? false;
                      return (
                        <Chip
                          key={d}
                          small
                          label={d}
                          selected={sel}
                          onPress={() => setForm({ ...form, daysOfWeek: sel ? (form.daysOfWeek ?? []).filter((x) => x !== i) : [...(form.daysOfWeek ?? []), i].sort() })}
                        />
                      );
                    })}
                  </View>
                ) : null}
                {!form.intervalDays && form.frequency === "MONTHLY" ? (
                  <View>
                    <Text style={ui.label}>Day of month</Text>
                    <TextInput
                      style={ui.input}
                      keyboardType="number-pad"
                      value={String(form.dayOfMonth ?? "")}
                      onChangeText={(t) => setForm({ ...form, dayOfMonth: Math.min(31, Math.max(1, Number(t.replace(/\D/g, "")) || 1)) })}
                    />
                  </View>
                ) : null}
                <View style={styles.rowBetween}>
                  <View style={{ flex: 1 }}>
                    <Text style={ui.body}>Reminder</Text>
                    <Text style={styles.meta}>{form.noReminder ? "No reminder and no set time" : "Before it starts, at the time, and once more if not done"}</Text>
                  </View>
                  <Switch
                    value={!form.noReminder}
                    onValueChange={(on) => setForm({ ...form, noReminder: !on, ...(on ? {} : { dueTime: null, timeLocked: false }) })}
                  />
                </View>
                {!form.noReminder ? (
                  <View>
                    <Text style={ui.label}>Time (empty: your usual time, 9 AM until learned)</Text>
                    <InlineTimePickerField value={form.dueTime ?? ""} onChange={(t) => setForm({ ...form, dueTime: t, timeLocked: form.timeLocked || true })} />
                  </View>
                ) : null}
                {form.dueTime ? (
                  <View style={styles.rowBetween}>
                    <View style={{ flex: 1 }}>
                      <Text style={ui.body}>Time-locked</Text>
                      <Text style={styles.meta}>Don't move it if missed (prayer, morning jog)</Text>
                    </View>
                    <Switch value={form.timeLocked} onValueChange={(timeLocked) => setForm({ ...form, timeLocked })} />
                  </View>
                ) : null}
                <View>
                  <Text style={ui.label}>Duration</Text>
                  <View style={ui.wrap}>
                    {[5, 10, 15, 30, 45, 60, 90].map((d) => (
                      <Chip key={d} small label={formatDuration(d)} selected={form.durationMinutes === d} onPress={() => setForm({ ...form, durationMinutes: form.durationMinutes === d ? null : d })} />
                    ))}
                  </View>
                </View>
                <View>
                  <Text style={ui.label}>Priority</Text>
                  <View style={ui.wrap}>
                    {PRIORITIES.map((p) => (
                      <Chip key={p.key} small label={p.label} selected={form.priority === p.key} onPress={() => setForm({ ...form, priority: p.key })} />
                    ))}
                  </View>
                  <Text style={styles.meta}>{PRIORITIES.find((p) => p.key === form.priority)?.hint}</Text>
                </View>
                <View>
                  <Text style={ui.label}>Category</Text>
                  <View style={ui.wrap}>
                    {CATEGORIES.map((c) => (
                      <Chip key={c} small label={c} selected={form.category === c} onPress={() => setForm({ ...form, category: form.category === c ? null : c })} />
                    ))}
                  </View>
                </View>
                {contexts.length ? (
                  <View>
                    <Text style={ui.label}>Context</Text>
                    <View style={ui.wrap}>
                      <Chip small label="Anywhere" selected={!form.locationContext} onPress={() => setForm({ ...form, locationContext: null })} />
                      {contexts.map((c) => (
                        <Chip key={c} small label={c} selected={form.locationContext === c} onPress={() => setForm({ ...form, locationContext: c })} />
                      ))}
                    </View>
                  </View>
                ) : null}
              </Card>
              {formError ? <Text style={ui.error}>{formError}</Text> : null}
              <Button title={form.id ? "Save routine" : "Create routine"} onPress={() => void save()} loading={saving} />
              {form.id ? (
                <Button
                  title="Delete routine"
                  kind="danger"
                  onPress={() =>
                    showAlert("Delete routine?", "Its history will be removed too.", [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Delete",
                        style: "destructive",
                        onPress: async () => {
                          const id = form.id as string;
                          setRoutines((list) => list.filter((r) => r.id !== id));
                          setToday((list) => list.filter((o) => o.routine.id !== id));
                          setForm(null);
                          await sendChange({ method: "DELETE", path: `/routines/${id}`, key: `routine-delete:${id}`, label: "Routine" }, "Routine deleted");
                        },
                      },
                    ])
                  }
                />
              ) : null}
            </ScrollView>
          </KeyboardPad>
        ) : null}
      </Modal>
      <Snackbar text={toast} onHide={() => setToast(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  topBar: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, paddingVertical: 6 },
  content: { paddingHorizontal: 20, paddingTop: 8, gap: 10 },
  sectionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 2 },
  listCard: { padding: 0, overflow: "hidden" },
  occRow: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, minHeight: 64, paddingVertical: 10 },
  tick: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  routineCard: { flexDirection: "row", alignItems: "flex-start", gap: 14, padding: 16, borderWidth: StyleSheet.hairlineWidth },
  routineIcon: { width: 38, height: 38, alignItems: "center", justifyContent: "center" },
  bar: { height: 4, borderRadius: 2, overflow: "hidden", width: "80%" },
  meta: { fontFamily: "Inter_400Regular", fontSize: 13, color: colors.textMuted },
  occ: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 },
});
