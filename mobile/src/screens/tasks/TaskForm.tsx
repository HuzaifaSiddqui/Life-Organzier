import { useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { TaskFormDueDateRow, TaskFormDueTimeRow } from "../../components/DueDateTimePickers";
import { Button, Card, Chip, ui } from "../../components/ui";
import { colors, palette } from "../../constants/theme";
import { usePreferences } from "../../context/PreferencesContext";
import { getTags } from "../../services/settingsApi";
import { apiGet, apiPost } from "../../services/api";
import { suggestForTitle, type TaskInput } from "../../services/tasksApi";
import { useLocale } from "../../i18n/LocaleProvider";
import { formatDuration } from "../../utils/format";
import type { Priority, ReminderMode, Task, TaskStatus, TaskType } from "../../types/models";
import {
  combineYmdAndTimeStrings,
  dueDateAndTimeForSave,
  dueDateTimeToDate,
  formatDueTime12h,
  parseDueTimeToHoursMinutes,
  validateDueDateNotPast,
  ymdFromLocalDate,
} from "../../utils/datetimeValidation";

const PRIORITIES: Priority[] = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const TYPES: Array<{ key: TaskType; label: string; hint: string }> = [
  { key: "DEADLINE", label: "Deadline", hint: "must be done by a date/time" },
  { key: "FLEXIBLE", label: "Flexible", hint: "fit into free time" },
  { key: "DURATION", label: "Focus block", hint: "needs a continuous slot" },
  { key: "FIXED", label: "Fixed event", hint: "class/meeting — can't move" },
];
const DURATIONS = [15, 30, 60, 90, 120, 180];
const REMINDERS: Array<{ key: ReminderMode; label: string }> = [
  { key: "ADAPTIVE", label: "Smart (adaptive)" },
  { key: "ESCALATING", label: "Escalating" },
  { key: "MULTIPLE", label: "A few" },
  { key: "SINGLE", label: "Just one" },
  { key: "NONE", label: "None" },
];
const REMIND_BEFORE: Array<{ label: string; minutes: number | null }> = [
  { label: "Auto", minutes: null },
  { label: "1 hour before", minutes: 60 },
  { label: "1 day before", minutes: 1440 },
];

export type TaskFormValues = {
  title: string;
  description: string;
  dueYmd: string;
  dueTime: string;
  priority: Priority;
  category: string | null;
  tags: string[];
  taskType: TaskType;
  durationMinutes: number | null;
  /** FR-RN-004 planned start (work block); local YYYY-MM-DD + clock text, both or neither. */
  plannedYmd: string;
  plannedTime: string;
  difficulty: number | null;
  locationContext: string | null;
  reminderMode: ReminderMode;
  reminderMinutes: number | null;
  status: TaskStatus;
};

export function valuesFromTask(t: Task): TaskFormValues {
  return {
    title: t.title,
    description: t.description ?? "",
    dueYmd: t.dueDate ? ymdFromLocalDate(new Date(t.dueDate)) : "",
    dueTime: t.dueTime ?? "",
    priority: t.priority,
    category: t.category,
    tags: Array.isArray(t.tags) ? t.tags : [],
    taskType: t.taskType && t.taskType !== "ROUTINE" ? t.taskType : "FLEXIBLE",
    durationMinutes: t.durationMinutes ?? null,
    plannedYmd: t.scheduledStart ? ymdFromLocalDate(new Date(t.scheduledStart)) : "",
    plannedTime: t.scheduledStart ? formatDueTime12h(new Date(t.scheduledStart)) : "",
    difficulty: t.difficulty ?? null,
    locationContext: t.locationContext ?? null,
    reminderMode: t.reminderMode ?? "ADAPTIVE",
    reminderMinutes: t.reminderMinutes ?? null,
    status: t.status,
  };
}

export const EMPTY_VALUES: TaskFormValues = {
  title: "",
  description: "",
  dueYmd: "",
  dueTime: "",
  priority: "MEDIUM",
  category: null,
  tags: [],
  taskType: "FLEXIBLE",
  durationMinutes: null,
  plannedYmd: "",
  plannedTime: "",
  difficulty: null,
  locationContext: null,
  reminderMode: "ADAPTIVE",
  reminderMinutes: null,
  status: "PENDING",
};

export function plannedStartFromValues(v: Pick<TaskFormValues, "plannedYmd" | "plannedTime">): Date | null {
  if (!v.plannedYmd || !v.plannedTime.trim() || !parseDueTimeToHoursMinutes(v.plannedTime)) return null;
  return combineYmdAndTimeStrings(v.plannedYmd, v.plannedTime);
}

/** Converts form values into the API payload; returns an error message when invalid. */
export function toPayload(v: TaskFormValues, opts: { allowPast?: boolean } = {}): { payload: Omit<TaskInput, "source">; error: string | null } {
  const { dueDateIso, dueTime } = dueDateAndTimeForSave({ pickerYmd: v.dueYmd, rawDueTime: v.dueTime });
  const planned = plannedStartFromValues(v);
  const error = !v.title.trim()
    ? "Title is required"
    : (v.plannedYmd || v.plannedTime) && !planned
      ? "Set both a date and a time for the planned start, or clear it."
    : dueTime && !dueDateIso
      ? "Couldn't read that time. Use the picker or a format like 3 PM."
      : opts.allowPast
        ? null
        : validateDueDateNotPast(dueDateIso, dueTime);
  return {
    error,
    payload: {
      title: v.title.trim(),
      description: v.description.trim() || null,
      dueDate: dueDateIso,
      dueTime,
      priority: v.priority,
      category: v.category,
      tags: v.tags.length ? v.tags : null,
      taskType: v.taskType,
      durationMinutes: v.durationMinutes,
      // The field is only shown with a duration; without one, an existing start (e.g. set by the assistant) is left alone.
      ...(v.durationMinutes
        ? {
            scheduledStart: planned ? planned.toISOString() : null,
            scheduledEnd: planned ? new Date(planned.getTime() + v.durationMinutes * 60000).toISOString() : null,
          }
        : {}),
      difficulty: v.difficulty,
      locationContext: v.locationContext,
      reminderMode: v.reminderMode,
      reminderMinutes: v.reminderMinutes,
      status: v.status,
    },
  };
}

export function TaskForm({
  initial,
  submitLabel,
  onSubmit,
  editing,
}: {
  initial: TaskFormValues;
  submitLabel: string;
  onSubmit: (values: TaskFormValues) => Promise<string | null>;
  editing?: boolean;
}) {
  const { categories, settings } = usePreferences();
  const [v, setV] = useState<TaskFormValues>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [suggested, setSuggested] = useState<{ category: string | null; tags: string[] }>({ category: null, tags: [] });
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const set = <K extends keyof TaskFormValues>(k: K, value: TaskFormValues[K]) => setV((prev) => ({ ...prev, [k]: value }));
  const { t } = useLocale();
  const [estimate, setEstimate] = useState<{ category: string; original: number; suggested: number; ratio: number } | null>(null);
  const shownKeys = useRef(new Set<string>());
  const acceptedMinutes = useRef<number | null>(null);
  const logEstimate = (action: "SHOWN" | "ACCEPTED", e: { category: string; original: number; suggested: number }) =>
    void apiPost("/events/estimate-suggestion", { action, category: e.category, original: e.original, suggested: e.suggested }).catch(() => undefined);
  // FR-RN-004 §6: offer the learned-estimate duration (one tap, never automatic).
  useEffect(() => {
    setEstimate(null);
    if (!v.category || !v.durationMinutes || v.durationMinutes === acceptedMinutes.current) return;
    let live = true;
    apiGet<{ suggestion: { category: string; original: number; suggested: number; ratio: number } | null }>("/events/estimate-suggestion", { params: { category: v.category, minutes: v.durationMinutes } })
      .then((r) => {
        if (!live || !r.suggestion) return;
        setEstimate(r.suggestion);
        const key = `${r.suggestion.category}:${r.suggestion.original}`;
        if (!shownKeys.current.has(key)) {
          shownKeys.current.add(key);
          logEstimate("SHOWN", r.suggestion);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.category, v.durationMinutes]);
  const [slotBusy, setSlotBusy] = useState(false);
  const [slotNote, setSlotNote] = useState<string | null>(null);
  /** "Find time for it": a free slot that ends before the deadline (existing scheduler); fills the planned start. */
  const findTime = async () => {
    if (!v.durationMinutes) return;
    setSlotBusy(true);
    setSlotNote(null);
    try {
      const { dueDateIso, dueTime } = dueDateAndTimeForSave({ pickerYmd: v.dueYmd, rawDueTime: v.dueTime });
      const deadline = dueDateIso ? dueDateTimeToDate(dueDateIso, dueTime) : null;
      const r = await apiPost<{ slot: { start: string; reason: string } | null }>("/scheduling/suggest", {
        durationMinutes: v.durationMinutes,
        priority: v.priority,
        difficulty: v.difficulty,
        deadline: deadline ? deadline.toISOString() : null,
      });
      if (!r.slot) setSlotNote(t("task.noSlot"));
      else {
        const start = new Date(r.slot.start);
        setV((p) => ({ ...p, plannedYmd: ymdFromLocalDate(start), plannedTime: formatDueTime12h(start) }));
        setSlotNote(r.slot.reason);
      }
    } catch {
      setSlotNote(t("checkin.error"));
    } finally {
      setSlotBusy(false);
    }
  };

  useEffect(() => setV(initial), [initial]);

  useEffect(() => {
    getTags()
      .then((t) => setKnownTags(t.map((x) => x.tag)))
      .catch(() => undefined);
  }, []);

  // System suggests category and tags from the title (FR-CT-001 §3, FR-CT-002 §4).
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (v.title.trim().length < 4) return;
    debounce.current = setTimeout(() => {
      void suggestForTitle(v.title).then(setSuggested);
    }, 500);
  }, [v.title]);

  const tagCompletions = useMemo(() => {
    const q = tagDraft.trim().toLowerCase().replace(/^#/, "");
    const pool = [...new Set([...suggested.tags, ...knownTags])].filter((t) => !v.tags.includes(t));
    return (q ? pool.filter((t) => t.startsWith(q)) : pool).slice(0, 8);
  }, [tagDraft, knownTags, suggested.tags, v.tags]);

  const addTag = (raw: string) => {
    const t = raw.trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-");
    if (t && !v.tags.includes(t)) set("tags", [...v.tags, t].slice(0, 20));
    setTagDraft("");
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const err = await onSubmit(v);
      if (err) setError(err);
    } finally {
      setBusy(false);
    }
  };

  const contexts = settings?.contexts ?? [];

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Card style={{ gap: 14 }}>
          <View>
            <Text style={ui.label}>Title</Text>
            <TextInput style={ui.input} value={v.title} onChangeText={(t) => set("title", t)} placeholder="What do you need to do?" placeholderTextColor="#646A78" />
          </View>
          <View>
            <Text style={ui.label}>Description</Text>
            <TextInput
              style={[ui.input, { minHeight: 70, textAlignVertical: "top" }]}
              value={v.description}
              onChangeText={(t) => set("description", t)}
              placeholder="Optional details"
              placeholderTextColor="#646A78"
              multiline
            />
          </View>
          <TaskFormDueDateRow valueYmd={v.dueYmd} onChangeYmd={(ymd) => set("dueYmd", ymd)} onClear={() => set("dueYmd", "")} />
          <TaskFormDueTimeRow valueTime={v.dueTime} onChangeTime={(t) => set("dueTime", t)} baseYmd={v.dueYmd || undefined} quickTimes={["9:00 AM", "12:00 PM", "3:00 PM", "6:00 PM", "11:59 PM"]} />

          <View>
            <Text style={ui.label}>Priority</Text>
            <View style={ui.wrap}>
              {PRIORITIES.map((p) => (
                <Chip key={p} small label={p} selected={v.priority === p} tone={p === "URGENT" ? "danger" : undefined} onPress={() => set("priority", p)} />
              ))}
            </View>
          </View>

          <View>
            <Text style={ui.label}>Category</Text>
            <View style={ui.wrap}>
              {categories.map((c) => (
                <Chip key={c.id} small label={c.name} selected={v.category === c.name} onPress={() => set("category", v.category === c.name ? null : c.name)} />
              ))}
            </View>
            {suggested.category && suggested.category !== v.category ? (
              <Text style={styles.suggest} onPress={() => set("category", suggested.category)}>
                Suggested category: {suggested.category} · tap to use
              </Text>
            ) : null}
          </View>

          <View>
            <Text style={ui.label}>Tags</Text>
            <View style={ui.wrap}>
              {v.tags.map((t) => (
                <Chip key={t} small selected label={`#${t} ✕`} onPress={() => set("tags", v.tags.filter((x) => x !== t))} />
              ))}
            </View>
            <TextInput
              style={[ui.input, { marginTop: 8 }]}
              value={tagDraft}
              onChangeText={setTagDraft}
              onSubmitEditing={() => addTag(tagDraft)}
              placeholder="Add a tag and press enter"
              placeholderTextColor="#646A78"
              autoCapitalize="none"
            />
            {tagCompletions.length ? (
              <View style={[ui.wrap, { marginTop: 8 }]}>
                {tagCompletions.map((t) => (
                  <Chip key={t} small tone={suggested.tags.includes(t) ? "accent" : undefined} label={`#${t}`} onPress={() => addTag(t)} />
                ))}
              </View>
            ) : null}
          </View>
        </Card>

        <Card style={{ gap: 14 }}>
          <View>
            <Text style={ui.label}>Type</Text>
            <View style={ui.wrap}>
              {TYPES.map((t) => (
                <Chip key={t.key} small label={t.label} selected={v.taskType === t.key} onPress={() => set("taskType", t.key)} />
              ))}
            </View>
            <Text style={styles.hint}>{TYPES.find((t) => t.key === v.taskType)?.hint}</Text>
          </View>
          <View>
            <Text style={ui.label}>How long will it take?</Text>
            <View style={ui.wrap}>
              {DURATIONS.map((d) => (
                <Chip key={d} small label={d < 60 ? `${d} min` : `${d / 60}h`} selected={v.durationMinutes === d} onPress={() => set("durationMinutes", v.durationMinutes === d ? null : d)} />
              ))}
            </View>
          </View>
          {estimate ? (
            <View>
              <Text style={styles.hint}>{t("task.estimateHint", { category: estimate.category, ratio: String(estimate.ratio), time: formatDuration(estimate.suggested) })}</Text>
              <Button
                title={t("task.estimateUse", { time: formatDuration(estimate.suggested) })}
                kind="secondary"
                size="sm"
                style={{ alignSelf: "flex-start", marginTop: 6 }}
                onPress={() => {
                  logEstimate("ACCEPTED", estimate);
                  acceptedMinutes.current = estimate.suggested;
                  set("durationMinutes", estimate.suggested);
                }}
              />
            </View>
          ) : null}
          {v.durationMinutes ? (
            <View>
              <Text style={ui.label}>{t("task.plannedStart")}</Text>
              <Text style={styles.hint}>{t("task.plannedStartHint")}</Text>
              <TaskFormDueDateRow label={t("task.plannedStart")} valueYmd={v.plannedYmd} onChangeYmd={(ymd) => set("plannedYmd", ymd)} onClear={() => setV((p) => ({ ...p, plannedYmd: "", plannedTime: "" }))} />
              <TaskFormDueTimeRow label=" " valueTime={v.plannedTime} onChangeTime={(time) => set("plannedTime", time)} baseYmd={v.plannedYmd || undefined} quickTimes={["9:00 AM", "2:00 PM", "4:00 PM", "7:00 PM", "9:00 PM"]} />
              {!v.plannedYmd && !v.plannedTime ? (
                <Button title={slotBusy ? t("task.findingTime") : t("task.findTime")} kind="secondary" size="sm" loading={slotBusy} onPress={() => void findTime()} style={{ alignSelf: "flex-start", marginTop: 6 }} />
              ) : null}
              {slotNote ? <Text style={styles.hint}>{slotNote}</Text> : null}
            </View>
          ) : null}
          <View>
            <Text style={ui.label}>Difficulty</Text>
            <View style={ui.wrap}>
              {[1, 2, 3, 4, 5].map((d) => (
                <Chip key={d} small label={["Easy", "Light", "Medium", "Hard", "Very hard"][d - 1]} selected={v.difficulty === d} onPress={() => set("difficulty", v.difficulty === d ? null : d)} />
              ))}
            </View>
            <Text style={styles.hint}>Hard tasks are placed in your most productive hours.</Text>
          </View>
          {contexts.length ? (
            <View>
              <Text style={ui.label}>Context</Text>
              <View style={ui.wrap}>
                <Chip small label="Anywhere" selected={!v.locationContext} onPress={() => set("locationContext", null)} />
                {contexts.map((c) => (
                  <Chip key={c} small label={c} selected={v.locationContext === c} onPress={() => set("locationContext", c)} />
                ))}
              </View>
            </View>
          ) : null}
          <View>
            <Text style={ui.label}>Reminders for this task</Text>
            <View style={ui.wrap}>
              {REMINDERS.map((r) => (
                <Chip key={r.key} small label={r.label} selected={v.reminderMode === r.key} onPress={() => set("reminderMode", r.key)} />
              ))}
            </View>
            <View style={[ui.wrap, { marginTop: 8 }]}>
              {REMIND_BEFORE.map((r) => (
                <Chip key={r.label} small label={r.label} selected={v.reminderMinutes === r.minutes} onPress={() => set("reminderMinutes", r.minutes)} />
              ))}
            </View>
          </View>
          {editing ? (
            <View>
              <Text style={ui.label}>Status</Text>
              <View style={ui.wrap}>
                {(["PENDING", "IN_PROGRESS", "COMPLETED"] as TaskStatus[]).map((s) => (
                  <Chip key={s} small label={s.replace("_", " ")} selected={v.status === s} onPress={() => set("status", s)} />
                ))}
              </View>
            </View>
          ) : null}
        </Card>

        {error ? <Text style={ui.error}>{error}</Text> : null}
        <Button title={submitLabel} onPress={() => void submit()} loading={busy} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14, paddingBottom: 48 },
  suggest: { color: palette.ai, fontFamily: "Inter_600SemiBold", marginTop: 8 },
  hint: { fontFamily: "Inter_400Regular", fontSize: 12, color: colors.textMuted, marginTop: 6 },
});
