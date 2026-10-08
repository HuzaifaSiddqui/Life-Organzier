import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { usePreferences } from "../context/PreferencesContext";
import { useLocale } from "../i18n/LocaleProvider";
import { openAppScreen } from "../navigation/navigationRef";
import { answerCheckin, showCheckinSheet, subscribeCheckinSheet, type CheckinResponse, type CheckinSheetState, type RespondResult } from "../services/checkins";
import { scheduleCheckin } from "../services/reminders";
import { updateTask } from "../services/tasksApi";
import { useTheme } from "../theme/ThemeProvider";
import { Button, Card, Chip, Sheet, Text } from "./ui";

const HINT_ID = "checkin-style";

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/**
 * FR-RN-004 in-app check-in sheet: opened from a check-in notification (tap, "Update…", or after a
 * direct answer). Answers go through `answerCheckin` (server is the source of truth; offline answers
 * queue with their tap time). Reschedule suggestions are only applied when the user books them.
 */
export function CheckinSheet() {
  const { t } = useLocale();
  const { spacing } = useTheme();
  const { settings, markTutorialSeen } = usePreferences();
  const [state, setState] = useState<CheckinSheetState | null>(null);
  const [busy, setBusy] = useState<CheckinResponse | "book" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showHint, setShowHint] = useState(false);

  useEffect(() => subscribeCheckinSheet((s) => {
    setState(s);
    setNote(null);
    setBusy(null);
  }), []);

  // One-time style hint the first time a check-in is seen in the app (stored in tutorialsSeen).
  useEffect(() => {
    if (state && settings && !settings.tutorialsSeen.includes(HINT_ID)) {
      setShowHint(true);
      void markTutorialSeen(HINT_ID);
    }
  }, [state, settings, markTutorialSeen]);

  const close = () => {
    showCheckinSheet(null);
    setShowHint(false);
  };

  if (!state) return null;
  const taskId = state.taskId;

  const answer = async (response: CheckinResponse) => {
    if (state.mode === "result") return;
    setBusy(response);
    try {
      const result = await answerCheckin(state.checkinId, state.taskId, response);
      if (result?.next) await scheduleCheckin(result.next);
      showCheckinSheet({ mode: "result", taskId: state.taskId, title: state.title, result, response });
    } catch {
      setNote(t("checkin.error"));
      setBusy(null);
    }
  };

  const book = async (r: RespondResult) => {
    if (!r.suggestion || !taskId) return;
    setBusy("book");
    try {
      await updateTask(taskId, { scheduledStart: r.suggestion.start, scheduledEnd: r.suggestion.end });
      setNote(t("checkin.booked", { time: timeLabel(r.suggestion.start) }));
    } catch {
      setNote(t("checkin.error"));
    } finally {
      setBusy(null);
    }
  };

  const openTask = (screen: "EditTask" | "TaskDetail") => {
    close();
    if (taskId) openAppScreen(screen, { taskId });
  };
  const split = () => {
    close();
    if (taskId) openAppScreen("Assistant", { payload: { type: "break_down", taskId }, label: t("checkin.split"), nonce: Date.now() });
  };

  const hint = showHint ? (
    <Card style={{ gap: 4 }}>
      <Text variant="bodyStrong">{t("checkin.hintTitle")}</Text>
      <Text variant="callout" color="secondary">
        {t("checkin.hintText")}
      </Text>
    </Card>
  ) : null;

  let title = state.title;
  let body: React.ReactNode = null;

  if (state.mode === "start") {
    body = (
      <>
        <Text variant="body" color="secondary">
          {state.body}
        </Text>
        <View style={styles.row}>
          <Button title={t("checkin.started")} onPress={() => void answer("STARTED")} loading={busy === "STARTED"} disabled={Boolean(busy)} style={styles.flex} />
          <Button title={t("checkin.notToday")} kind="secondary" onPress={() => void answer("NOT_TODAY")} loading={busy === "NOT_TODAY"} disabled={Boolean(busy)} style={styles.flex} />
        </View>
        <Button title={t("checkin.split")} kind="ghost" size="sm" onPress={split} />
      </>
    );
  } else if (state.mode === "update") {
    title = t("checkin.titleUpdate");
    body = (
      <>
        <Text variant="body" color="secondary">
          {state.title}
        </Text>
        <View style={styles.row}>
          <Button title={t("checkin.done")} onPress={() => void answer("DONE")} loading={busy === "DONE"} disabled={Boolean(busy)} style={styles.flex} />
          <Button title={t("checkin.plus30")} kind="secondary" onPress={() => void answer("PLUS_30")} loading={busy === "PLUS_30"} disabled={Boolean(busy)} style={styles.flex} />
        </View>
        <Text variant="label" color="tertiary">
          {t("checkin.partly").toUpperCase()}
        </Text>
        <View style={styles.chips}>
          {(["PARTIAL_25", "PARTIAL_50", "PARTIAL_75"] as const).map((r) => (
            <Chip key={r} label={`${r.split("_")[1]}%`} onPress={() => !busy && void answer(r)} />
          ))}
        </View>
        <Text variant="label" color="tertiary">
          {t("checkin.moreTime").toUpperCase()}
        </Text>
        <View style={styles.chips}>
          <Chip label={t("checkin.more15")} onPress={() => !busy && void answer("MORE_15")} />
          <Chip label={t("checkin.more60")} onPress={() => !busy && void answer("MORE_60")} />
        </View>
        <Button title={t("checkin.didnt")} kind="ghost" onPress={() => void answer("DIDNT")} loading={busy === "DIDNT"} disabled={Boolean(busy)} />
      </>
    );
  } else {
    const r = state.result;
    const needsPlan = r && (r.suggestion || r.refused || r.deadlineWarning || state.response === "NOT_TODAY" || state.response === "DIDNT" || state.response.startsWith("PARTIAL_"));
    body = (
      <>
        <Text variant="body">{r ? (r.message ?? "") : t("checkin.offlineSaved")}</Text>
        {r?.suggestion ? (
          <Card style={{ gap: spacing.sm }}>
            <Text variant="label" color="tertiary">
              {t("checkin.suggested").toUpperCase()}
            </Text>
            <Text variant="bodyStrong">{r.suggestion.reason}</Text>
            <Button title={t("checkin.book")} size="sm" onPress={() => void book(r)} loading={busy === "book"} disabled={Boolean(busy)} style={{ alignSelf: "flex-start" }} />
          </Card>
        ) : null}
        {needsPlan ? (
          <View style={styles.row}>
            <Button title={r?.refused || r?.deadlineWarning || state.response.startsWith("PARTIAL_") ? t("checkin.planRest") : t("checkin.pickTime")} kind="secondary" size="sm" onPress={() => openTask("EditTask")} style={styles.flex} />
            {state.response === "NOT_TODAY" || state.response === "DIDNT" ? <Button title={t("checkin.split")} kind="ghost" size="sm" onPress={split} style={styles.flex} /> : null}
          </View>
        ) : null}
      </>
    );
  }

  return (
    <Sheet visible onClose={close} title={state.mode === "start" ? t("checkin.titleStart") : title}>
      <View style={{ gap: spacing.md }}>
        {state.mode === "start" ? (
          <Text variant="bodyStrong" numberOfLines={2}>
            {state.title}
          </Text>
        ) : null}
        {body}
        {note ? (
          <Text variant="callout" color="secondary">
            {note}
          </Text>
        ) : null}
        {hint}
        <Button title={t("checkin.close")} kind="ghost" size="sm" onPress={close} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  flex: { flex: 1 },
});
