import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLocale } from "../../i18n/LocaleProvider";
import { agendaFor, calendarSyncActive, enableCalendarSync, freeTimeFor, syncCalendar, type EnableResult } from "../../services/calendar";
import { useTheme } from "../../theme/ThemeProvider";
import type { ActionPayload, AssistantCard } from "../../types/models";
import type { BusyEvent } from "../../utils/calendarSync";
import { formatTime } from "../../utils/format";
import { Icon } from "../icons/Icon";
import { Button, Card, Text } from "../ui";

type CalendarCardData = Extract<AssistantCard, { type: "calendar" }>;
type ClashCardData = Extract<AssistantCard, { type: "calendar_clash" }>;

const clock = (ms: number) => formatTime(new Date(ms).toISOString());

/**
 * CALENDAR_SYNC chat card, filled in on the phone from its own calendars (the server only chose the day or the task).
 * Agenda: every calendar on the phone, ours included. Free: gaps of 30 min or more between 8 AM and 10 PM. Add: syncs now.
 * Off: offers to turn calendar sync on (permission dialog).
 */
export function CalendarCard({ card, onAction }: { card: CalendarCardData; onAction: (payload: ActionPayload, label: string) => void }) {
  const { colors, spacing } = useTheme();
  const { t } = useLocale();
  const [active, setActive] = useState<boolean | null>(null);
  const [events, setEvents] = useState<BusyEvent[] | null>(null);
  const [slots, setSlots] = useState<Array<{ start: number; end: number }> | null>(null);
  const [problem, setProblem] = useState<Exclude<EnableResult, "on"> | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const on = await calendarSyncActive();
    setActive(on);
    if (!on) return;
    if (card.kind === "agenda") setEvents(await agendaFor(card.date));
    else if (card.kind === "free") setSlots(await freeTimeFor(card.date));
    else await syncCalendar();
  }, [card.date, card.kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const turnOn = async () => {
    setBusy(true);
    const r = await enableCalendarSync();
    setBusy(false);
    setProblem(r === "on" ? null : r);
    await load();
  };

  if (active === null) return null;
  // "add X to my calendar" found no task, so X was added: Keep / Undo (it syncs like any other task when kept).
  if (card.kind === "new" && card.taskId) {
    return <KeepUndo text={t("calendar.newKeep")} kept={t(active ? "calendar.added" : "calendar.kept")} taskId={card.taskId} onAction={onAction} />;
  }
  if (!active) {
    return (
      <Card style={{ gap: spacing.sm }}>
        <Text variant="body">{t("calendar.off")}</Text>
        {problem ? (
          <Text variant="caption" color="danger">
            {t(problem === "denied" ? "calendar.denied" : "calendar.unavailable")}
          </Text>
        ) : null}
        <Button
          title={t("calendar.turnOn")}
          kind="secondary"
          size="sm"
          loading={busy}
          disabled={busy}
          icon={<Icon name="calendar" size={18} color={colors.accent} />}
          onPress={() => void turnOn()}
          style={styles.start}
        />
      </Card>
    );
  }

  if (card.kind === "add") {
    return (
      <Card>
        <Text variant="caption" color="success">
          {t("calendar.added")}
        </Text>
      </Card>
    );
  }

  if (card.kind === "agenda") {
    return (
      <Card style={{ gap: spacing.xs }}>
        {events?.length ? (
          events.map((e, i) => (
            <View key={`${e.start}-${i}`} style={[styles.row, { gap: spacing.sm }]}>
              <Text variant="caption" color="secondary" style={styles.time}>
                {e.allDay ? t("calendar.allDay") : `${clock(e.start)}–${clock(e.end)}`}
              </Text>
              <Text variant="body" style={styles.flex} numberOfLines={2}>
                {e.title}
              </Text>
            </View>
          ))
        ) : (
          <Text variant="body" color="secondary">
            {t("calendar.nothing")}
          </Text>
        )}
      </Card>
    );
  }

  return (
    <Card style={{ gap: spacing.xs }}>
      {slots?.length ? (
        slots.map((s) => (
          <Text key={s.start} variant="body">
            {clock(s.start)} – {clock(s.end)}
          </Text>
        ))
      ) : (
        <Text variant="body" color="secondary">
          {t("calendar.noFree")}
        </Text>
      )}
      <Text variant="caption" color="secondary">
        {t("calendar.freeHint")}
      </Text>
    </Card>
  );
}

/** After chat added a task that overlaps an event on the phone's other calendars: Keep, or Undo (removes the task). */
export function CalendarClashCard({ card, onAction }: { card: ClashCardData; onAction: (payload: ActionPayload, label: string) => void }) {
  const { t } = useLocale();
  const text = card.more
    ? t("calendar.clashChatMore", { title: card.title, count: String(card.more), time: card.time })
    : t("calendar.clashChat", { title: card.title, time: card.time });
  return <KeepUndo tone="warning" text={text} kept={t("calendar.kept")} taskId={card.taskId} onAction={onAction} />;
}

function KeepUndo({ text, kept, taskId, onAction, tone }: { text: string; kept: string; taskId: string; onAction: (payload: ActionPayload, label: string) => void; tone?: "warning" }) {
  const { spacing } = useTheme();
  const { t } = useLocale();
  const [answer, setAnswer] = useState<"kept" | "undone" | null>(null);
  return (
    <Card tone={tone} style={{ gap: spacing.sm }}>
      <Text variant="body">{text}</Text>
      {answer === "kept" ? (
        <Text variant="caption" color="secondary">
          {kept}
        </Text>
      ) : answer === null ? (
        <View style={[styles.row, { gap: spacing.sm }]}>
          <Button title={t("calendar.keep")} kind="secondary" size="sm" onPress={() => setAnswer("kept")} />
          <Button
            title={t("calendar.undo")}
            kind="ghost"
            size="sm"
            onPress={() => {
              setAnswer("undone");
              onAction({ type: "undo_task", taskId }, t("calendar.undo"));
            }}
          />
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  start: { alignSelf: "flex-start" },
  row: { flexDirection: "row", alignItems: "flex-start" },
  time: { width: 112, paddingTop: 2 },
  flex: { flex: 1 },
});
