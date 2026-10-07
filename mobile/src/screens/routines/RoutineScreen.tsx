import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { InlineTimePickerField } from "../../components/DueDateTimePickers";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Button, Card, Chip, EmptyState, HelpButton, ProgressBar, SectionTitle, Snackbar, TutorialTip, ui } from "../../components/ui";
import { colors, palette } from "../../constants/theme";
import { usePreferences } from "../../context/PreferencesContext";
import type { MainStackParamList } from "../../navigation/MainStack";
import { apiErrorCode, getApiErrorMessage } from "../../services/api";
import {
  createRoutine,
  deleteRoutine,
  getRoutines,
  getTodayOccurrences,
  updateRoutine,
  updateRoutineOccurrence,
  type RoutineInput,
} from "../../services/routinesApi";
import type { Routine, RoutineFrequency, RoutineOccurrence, RoutinePriority } from "../../types/models";
import { formatDuration, WEEKDAYS_SHORT } from "../../utils/format";

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
};

function freqLabel(r: Routine): string {
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

export function RoutineScreen({ navigation }: Props) {
  const { settings } = usePreferences();
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [today, setToday] = useState<Array<RoutineOccurrence & { routine: Routine }>>([]);
  const [showAll, setShowAll] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, t] = await Promise.all([getRoutines(showAll), getTodayOccurrences()]);
      setRoutines(r.routines);
      setToday(t);
    } catch (e) {
      setToast(getApiErrorMessage(e));
    }
  }, [showAll]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const setOccurrence = async (o: RoutineOccurrence & { routine: Routine }, status: "COMPLETED" | "SKIPPED", confirm = false) => {
    try {
      await updateRoutineOccurrence(o.id, status, confirm);
      setToast(status === "COMPLETED" ? `${o.routine.title} done` : `Skipped ${o.routine.title}`);
      await load();
    } catch (e) {
      if (apiErrorCode(e) === "MANDATORY_CONFIRMATION_REQUIRED") {
        Alert.alert("Mandatory routine", getApiErrorMessage(e), [
          { text: "Keep it", style: "cancel" },
          { text: "Skip anyway", style: "destructive", onPress: () => void setOccurrence(o, status, true) },
        ]);
        return;
      }
      setToast(getApiErrorMessage(e));
    }
  };

  const save = async () => {
    if (!form) return;
    if (!form.title.trim()) {
      setFormError("Give the routine a name");
      return;
    }
    if ((form.frequency === "WEEKLY" || form.frequency === "CUSTOM") && !form.daysOfWeek?.length) {
      setFormError("Pick at least one day");
      return;
    }
    setSaving(true);
    setFormError(null);
    const payload: RoutineInput = {
      title: form.title.trim(),
      frequency: form.frequency,
      daysOfWeek: form.frequency === "WEEKLY" || form.frequency === "CUSTOM" ? form.daysOfWeek : null,
      dayOfMonth: form.frequency === "MONTHLY" ? form.dayOfMonth : null,
      dueTime: form.dueTime || null,
      durationMinutes: form.durationMinutes,
      category: form.category,
      priority: form.priority,
      timeLocked: Boolean(form.dueTime) && form.timeLocked,
      locationContext: form.locationContext,
    };
    try {
      if (form.id) await updateRoutine(form.id, payload);
      else await createRoutine(payload);
      setToast(form.id ? "Routine updated" : `Created ${payload.title}`);
      setForm(null);
      await load();
    } catch (e) {
      setFormError(getApiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const contexts = settings?.contexts ?? [];

  return (
    <View style={ui.screen}>
      <ScreenHeader
        title="Routines"
        onBack={() => navigation.goBack()}
        right={<HelpButton title="Routines" text="Recurring activities. Time-locked routines (prayer, morning walk) are never moved — if missed, the next one is ready. Flexible ones (dentist, bills) can be rescheduled. Mandatory routines are scheduled first." example={'Tell the assistant: "Mandatory daily prayer at 5 AM"'} />}
      />
      <ScrollView contentContainerStyle={ui.content}>
        <TutorialTip id="routines" title="Create recurring activities here" text="Try “Daily meditation at 6 AM for 10 minutes” in the assistant, or tap New routine." />
        <SectionTitle title="Today" right={settings?.currentContext ? <Text style={styles.meta}>{settings.currentContext}</Text> : undefined} />
        {today.length ? (
          today.map((o) => (
            <Card key={o.id} style={styles.occ}>
              <View style={{ flex: 1 }}>
                <Text style={[ui.body, { fontFamily: "Inter_600SemiBold" }, o.status !== "PENDING" && { color: colors.textMuted }]}>
                  
                  {o.routine.title}
                </Text>
                <Text style={styles.meta}>
                  {o.dueTime ?? "Any time"}
                  {o.routine.durationMinutes ? ` · ${formatDuration(o.routine.durationMinutes)}` : ""}
                  {o.routine.timeLocked ? " · time-locked" : ""}
                  {o.status !== "PENDING" ? ` · ${o.status.toLowerCase()}` : ""}
                </Text>
              </View>
              {o.status === "PENDING" ? (
                <View style={{ flexDirection: "row", gap: 6 }}>
                  <Chip small selected label="Done" onPress={() => void setOccurrence(o, "COMPLETED")} />
                  <Chip small label="Skip" onPress={() => void setOccurrence(o, "SKIPPED")} />
                </View>
              ) : null}
            </Card>
          ))
        ) : (
          <Text style={styles.meta}>No routines today{settings?.currentContext ? ` for ${settings.currentContext}` : ""}.</Text>
        )}

        <SectionTitle
          title="All routines"
          right={contexts.length ? <Chip small label={showAll ? "All contexts" : "This context"} onPress={() => setShowAll((v) => !v)} /> : undefined}
        />
        {routines.length === 0 ? (
          <EmptyState title="No routines yet" text="Build habits that the assistant protects when it plans your day." />
        ) : (
          routines.map((r) => {
            const a = adherence(r);
            return (
              <Pressable
                key={r.id}
                onPress={() => setForm({ ...EMPTY, ...r, id: r.id, daysOfWeek: r.daysOfWeek ?? [], dayOfMonth: r.dayOfMonth ?? 1 })}
              >
                <Card style={{ gap: 6, opacity: r.active ? 1 : 0.55 }}>
                  <View style={styles.rowBetween}>
                    <Text style={[ui.body, { fontFamily: "Inter_600SemiBold", flex: 1 }]}>
                      
                      {r.title}
                    </Text>
                    <Switch value={r.active} onValueChange={(active) => void updateRoutine(r.id, { active }).then(load)} />
                  </View>
                  <Text style={styles.meta}>
                    {freqLabel(r)} · {r.dueTime ?? "flexible time"}
                    {r.durationMinutes ? ` · ${formatDuration(r.durationMinutes)}` : ""}
                    {r.locationContext ? ` · ${r.locationContext}` : ""}
                    {r.timeLocked ? " · Time-locked" : ""}
                  </Text>
                  {a ? (
                    <View style={{ gap: 3 }}>
                      <ProgressBar value={a.pct} color={a.pct >= 80 ? palette.success : a.pct >= 50 ? palette.warning : palette.danger} height={5} />
                      <Text style={styles.meta}>
                        {a.pct}% kept over the last {a.total} times{a.pct >= 90 && a.total >= 7 ? " · Reliable" : ""}
                      </Text>
                    </View>
                  ) : null}
                </Card>
              </Pressable>
            );
          })
        )}
        <Button title="＋ New routine" onPress={() => setForm({ ...EMPTY })} />
      </ScrollView>

      <Modal visible={Boolean(form)} animationType="slide" onRequestClose={() => setForm(null)}>
        {form ? (
          <View style={ui.screen}>
            <ScreenHeader title={form.id ? "Edit routine" : "New routine"} onBack={() => setForm(null)} />
            <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
              <Card style={{ gap: 14 }}>
                <View>
                  <Text style={ui.label}>Name</Text>
                  <TextInput style={ui.input} value={form.title} onChangeText={(title) => setForm({ ...form, title })} placeholder="e.g. Morning walk" placeholderTextColor="#646A78" />
                </View>
                <View>
                  <Text style={ui.label}>How often?</Text>
                  <View style={ui.wrap}>
                    {FREQS.map((f) => (
                      <Chip key={f.key} small label={f.label} selected={form.frequency === f.key} onPress={() => setForm({ ...form, frequency: f.key })} />
                    ))}
                  </View>
                </View>
                {form.frequency === "WEEKLY" || form.frequency === "CUSTOM" ? (
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
                {form.frequency === "MONTHLY" ? (
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
                <View>
                  <Text style={ui.label}>Time (leave empty for flexible)</Text>
                  <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                    <InlineTimePickerField value={form.dueTime ?? ""} onChange={(t) => setForm({ ...form, dueTime: t, timeLocked: form.timeLocked || true })} style={{ flex: 1 }} />
                    {form.dueTime ? <Chip small label="Flexible" onPress={() => setForm({ ...form, dueTime: null, timeLocked: false })} /> : null}
                  </View>
                </View>
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
                    Alert.alert("Delete routine?", "Its history will be removed too.", [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Delete",
                        style: "destructive",
                        onPress: async () => {
                          await deleteRoutine(form.id as string);
                          setForm(null);
                          void load();
                        },
                      },
                    ])
                  }
                />
              ) : null}
            </ScrollView>
          </View>
        ) : null}
      </Modal>
      <Snackbar text={toast} onHide={() => setToast(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  meta: { fontFamily: "Inter_400Regular", fontSize: 13, color: colors.textMuted },
  occ: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 },
});
