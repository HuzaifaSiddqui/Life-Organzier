import { useLegacy, useLegacyStyles, type Legacy } from "../../theme/legacy";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { DeadlineReviewItem, type ReviewFlags } from "../DeadlineReviewItem";
import { InstructionPanel } from "../DocumentInstruction";
import { DocumentTextView } from "../DocumentTextView";
import { Button, Card, Chip, SectionTitle, ui, useUi } from "../ui";
import { Icon } from "../icons/Icon";
import { colors, palette } from "../../constants/theme";
import { useLocale } from "../../i18n/LocaleProvider";
import { getApiErrorMessage } from "../../services/api";
import {
  applyDocument,
  DOC_KINDS,
  pickLines,
  reextractDocument,
  setDocumentInstruction,
  type DocKind,
  type ExtractedDeadline,
  type ProcessResult,
} from "../../services/documentsApi";
import { WEEKDAYS_SHORT } from "../../utils/format";

/**
 * The review of what was read from a document (FR-DP-002 §3): tick, correct and add deadlines and classes. Used by
 * the review screen, which opens from a document card in chat or from My documents. Moved here unchanged from the
 * old Documents screen.
 */

/** filteredOut: DOC_INSTRUCTIONS, left out by the user's request (hidden unless "Show everything", never pre-ticked). */
type EditableDeadline = { index: number; title: string; date: string; time: string; confidence: number; include: boolean; created: boolean; existing: boolean; source: string; flags: ReviewFlags; filteredOut: boolean };
type EditableSchedule = { index: number; title: string; room: string; roomCheck: boolean; days: number[]; time: string; durationMinutes: number | null; confidence: number; include: boolean; created: boolean; existing: boolean; filteredOut: boolean };

function confColor(c: number): string {
  return c >= 90 ? palette.success : c >= 80 ? palette.warning : palette.danger;
}

function toEditable(d: ExtractedDeadline): EditableDeadline {
  return {
    index: d.index,
    title: d.title,
    date: d.date ?? "",
    time: d.time ?? "",
    confidence: d.confidence,
    // Pre-ticked only when the rules were fairly sure and there is a date; AI-only items wait for the user.
    include: !d.created && d.confidence >= 80 && Boolean(d.date) && !d.aiOnly && !d.removedSinceUpload && !d.filteredOut,
    created: Boolean(d.created),
    existing: Boolean(d.existing),
    // DOC_EVIDENCE: the document line it came from, when the server checked it.
    source: d.evidence ?? d.source,
    flags: { assumedTime: d.assumedTime, needsSemesterStart: d.needsSemesterStart, aiOnly: d.aiOnly, rangeStart: d.rangeStart, yearInferred: d.yearInferred, yearCorrected: d.yearCorrected, removedSinceUpload: d.removedSinceUpload, verified: d.verified, modelsAgree: d.modelsAgree },
    filteredOut: Boolean(d.filteredOut),
  };
}

function toSchedules(extracted: ProcessResult["extracted"]): EditableSchedule[] {
  return extracted.schedules.map((s) => ({
    index: s.index,
    title: s.title,
    room: s.room ?? "",
    roomCheck: Boolean(s.roomCheck),
    days: s.daysOfWeek,
    time: s.time ?? "",
    durationMinutes: s.durationMinutes,
    confidence: s.confidence,
    include: !s.created && s.daysOfWeek.length > 0 && !s.filteredOut,
    created: Boolean(s.created),
    existing: Boolean(s.existing),
    filteredOut: Boolean(s.filteredOut),
  }));
}

export function DocumentReview({
  initial,
  onToast,
  onAddManually,
}: {
  initial: ProcessResult;
  onToast: (text: string) => void;
  onAddManually: () => void;
}) {
  const ui = useUi();
  const { colors, palette } = useLegacy();
  const styles = useLegacyStyles(make_styles);
  const { t } = useLocale();
  const [result, setResult] = useState<ProcessResult>(initial);
  const [deadlines, setDeadlines] = useState<EditableDeadline[]>(() => initial.extracted.deadlines.map(toEditable));
  const [schedules, setSchedules] = useState<EditableSchedule[]>(() => toSchedules(initial.extracted));
  const [applying, setApplying] = useState(false);
  /** DOC_ROUTING "Wrong type?" re-read, or DOC_FALLBACK_UI "Pick lines", in progress. */
  const [rereading, setRereading] = useState(false);
  const [showAll, setShowAll] = useState(false);

  /** The review rows for what the server extracted (and, with a request, what it leaves out). */
  const showItems = (extracted: ProcessResult["extracted"]) => {
    setShowAll(false);
    setDeadlines(extracted.deadlines.map(toEditable));
    setSchedules(toSchedules(extracted));
  };

  useEffect(() => {
    setResult(initial);
    showItems(initial.extracted);
  }, [initial]);

  /** DOC_INSTRUCTIONS: a changed request, or the person picked for "which one?". Re-filters what was read. */
  const changeRequest = async (text: string, person?: string) => {
    setRereading(true);
    try {
      const r = await setDocumentInstruction(result.document.id, text, person);
      setResult({ ...result, extracted: r.extracted, reused: false });
      showItems(r.extracted);
    } catch (e) {
      onToast(getApiErrorMessage(e));
    } finally {
      setRereading(false);
    }
  };

  /** DOC_ROUTING: read the same document again as the type the user picked. */
  const reread = async (kind: DocKind) => {
    setRereading(true);
    try {
      const r = await reextractDocument(result.document.id, kind);
      setResult({ ...result, extracted: r.extracted, reused: false });
      showItems(r.extracted);
    } catch (e) {
      onToast(getApiErrorMessage(e));
    } finally {
      setRereading(false);
    }
  };

  /** DOC_FALLBACK_UI: picked lines become review items (ticked only when they have a date). */
  const addPicked = async (lines: string[]) => {
    setRereading(true);
    try {
      const r = await pickLines(result.document.id, lines);
      setDeadlines((l) => {
        const base = Math.max(-1, ...l.map((d) => d.index)) + 1;
        return [...l, ...r.deadlines.map((d, i) => ({ ...toEditable({ ...d, index: base + i }), include: Boolean(d.date) }))];
      });
      onToast(`Added ${r.deadlines.length} item${r.deadlines.length === 1 ? "" : "s"} for review`);
    } catch (e) {
      onToast(getApiErrorMessage(e));
    } finally {
      setRereading(false);
    }
  };

  const apply = async () => {
    const ds = deadlines.filter((d) => d.include && !d.created);
    const ss = schedules.filter((s) => s.include && !s.created);
    if (ds.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d.date))) {
      onToast("Each selected deadline needs a date (YYYY-MM-DD).");
      return;
    }
    setApplying(true);
    try {
      const r = await applyDocument(result.document.id, {
        deadlines: ds.map((d) => ({ title: d.title, date: d.date, time: d.time || null })),
        schedules: ss.filter((s) => s.days.length).map((s) => ({ title: s.title, daysOfWeek: s.days, time: s.time || null, durationMinutes: s.durationMinutes, location: s.room.trim() || null })),
      });
      onToast(`Created ${r.tasks.length} task${r.tasks.length === 1 ? "" : "s"} and ${r.routines.length} routine${r.routines.length === 1 ? "" : "s"}`);
      setDeadlines((l) => l.map((d) => (d.include ? { ...d, created: true, include: false } : d)));
      setSchedules((l) => l.map((s) => (s.include ? { ...s, created: true, include: false } : s)));
    } catch (e) {
      onToast(getApiErrorMessage(e));
    } finally {
      setApplying(false);
    }
  };

  const course = result.extracted.course;
  // DOC_INSTRUCTIONS: items the request leaves out stay hidden until "Show everything".
  const shownDeadlines = deadlines.filter((d) => showAll || !d.filteredOut);
  const shownSchedules = schedules.filter((s) => showAll || !s.filteredOut);
  const hiddenCount = showAll ? 0 : deadlines.length + schedules.length - shownDeadlines.length - shownSchedules.length;
  const pending = deadlines.filter((d) => d.include && !d.created).length + schedules.filter((s) => s.include && !s.created).length;

  return (
    <>
      {!result.text && !result.extracted.deadlines.length && !result.extracted.schedules.length && !result.extracted.warning ? (
        <Card tone="warning" style={{ gap: 6 }}>
          <Text style={ui.body}>I couldn't find any dated deadlines or class times in this file.</Text>
          <Text style={styles.meta}>Make sure it has dates like "Oct 20, 2026" or class times like "Mon 9:00 AM", or paste the text in chat.</Text>
        </Card>
      ) : null}
      {result.extracted.warning ? (
        <Card tone="warning" style={{ gap: 8 }}>
          <Text style={ui.body}>{result.extracted.warning}</Text>
          <Text style={styles.meta}>
            {result.extracted.needsLanguage ? "Send the file again in chat and say which language it's in (for example \"it's in Urdu\")." : "Try a clearer image, or review the results below anyway."}
          </Text>
        </Card>
      ) : null}
      {result.extracted.method === "ocr" ? <Text style={styles.meta}>OCR confidence {result.extracted.ocrConfidence}%</Text> : null}
      {result.extracted.kind ? (
        <Card style={{ gap: 8 }}>
          <Text style={ui.body}>{t("docRoute.readAs", { kind: t(`docRoute.kind.${result.extracted.kind.kind}`) })}</Text>
          {result.extracted.kind.kind === "other" ? <Text style={styles.meta}>{t("docRoute.otherNote")}</Text> : null}
          <Text style={styles.meta}>{t("docRoute.wrongType")}</Text>
          <View style={ui.wrap}>
            {DOC_KINDS.filter((k) => k !== result.extracted.kind?.kind).map((k) => (
              <Chip key={k} small label={t(`docRoute.kind.${k}`)} onPress={rereading ? undefined : () => void reread(k)} />
            ))}
          </View>
        </Card>
      ) : null}
      {result.extracted.instruction ? (
        <InstructionPanel
          key={`${result.document.id}:${result.extracted.instruction.instruction}:${result.extracted.instruction.status}`}
          result={result.extracted.instruction}
          showAll={showAll}
          busy={rereading}
          onToggleShowAll={() => setShowAll((v) => !v)}
          onChange={(text, person) => void changeRequest(text, person)}
        />
      ) : null}
      {result.text ? (
        <DocumentTextView
          key={result.document.id}
          text={result.text}
          empty={!deadlines.length && !schedules.length}
          busy={rereading}
          onPick={(lines) => void addPicked(lines)}
          onAddManually={onAddManually}
        />
      ) : null}

      <SectionTitle title={`Extracted deadlines (${shownDeadlines.length})`} />
      {shownDeadlines.length ? (
        shownDeadlines.map((d) => (
          <Card key={d.index} style={{ gap: 8, opacity: d.created ? 0.7 : 1 }}>
            <View style={styles.rowBetween}>
              <Pressable
                disabled={d.created}
                onPress={() => setDeadlines((l) => l.map((x) => (x.index === d.index ? { ...x, include: !x.include } : x)))}
                style={[styles.box, (d.include || d.created) && styles.boxOn]}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: d.include || d.created, disabled: d.created }}
              >
                {d.include || d.created ? <Icon name="check" size={14} color={colors.surface} /> : null}
              </Pressable>
              <TextInput style={[ui.input, { flex: 1, paddingVertical: 8 }]} value={d.title} editable={!d.created} onChangeText={(title) => setDeadlines((l) => l.map((x) => (x.index === d.index ? { ...x, title } : x)))} />
            </View>
            <DeadlineReviewItem
              date={d.date}
              time={d.time}
              source={d.source}
              flags={d.created ? { assumedTime: false } : d.flags}
              disabled={d.created}
              onChangeDate={(date) => setDeadlines((l) => l.map((x) => (x.index === d.index ? { ...x, date, include: true, flags: { ...x.flags, needsSemesterStart: false } } : x)))}
              onChangeTime={(time) => setDeadlines((l) => l.map((x) => (x.index === d.index ? { ...x, time, flags: { ...x.flags, assumedTime: false } } : x)))}
            />
            <Text style={[styles.meta, { color: confColor(d.confidence) }]}>
              {d.existing ? "Already in your tasks · " : d.created ? "Added · " : ""}Confidence {d.confidence}%
            </Text>
          </Card>
        ))
      ) : (
        <Text style={styles.meta}>No deadlines found.</Text>
      )}

      <SectionTitle title={`Extracted schedules (${shownSchedules.length})`} />
      {shownSchedules.length > 5 ? <Text style={styles.meta}>Found {shownSchedules.length} classes — choose which to create.</Text> : null}
      {shownSchedules.length ? (
        shownSchedules.map((s) => (
          <Card key={s.index} style={{ gap: 8, opacity: s.created ? 0.7 : 1 }}>
            <View style={styles.rowBetween}>
              <Pressable
                disabled={s.created}
                onPress={() => setSchedules((l) => l.map((x) => (x.index === s.index ? { ...x, include: !x.include } : x)))}
                style={[styles.box, (s.include || s.created) && styles.boxOn]}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: s.include || s.created, disabled: s.created }}
              >
                {s.include || s.created ? <Icon name="check" size={14} color={colors.surface} /> : null}
              </Pressable>
              <TextInput style={[ui.input, { flex: 1, paddingVertical: 8 }]} value={s.title} editable={!s.created} onChangeText={(title) => setSchedules((l) => l.map((x) => (x.index === s.index ? { ...x, title } : x)))} />
            </View>
            <View style={ui.wrap}>
              {WEEKDAYS_SHORT.map((label, d) => (
                <Chip
                  key={label}
                  small
                  label={label}
                  selected={s.days.includes(d)}
                  onPress={s.created ? undefined : () => setSchedules((l) => l.map((x) => (x.index === s.index ? { ...x, days: x.days.includes(d) ? x.days.filter((y) => y !== d) : [...x.days, d].sort() } : x)))}
                />
              ))}
            </View>
            <TextInput style={[ui.input, { paddingVertical: 8 }]} value={s.time} placeholder="Time, e.g. 10 AM" placeholderTextColor={palette.muted} editable={!s.created} onChangeText={(time) => setSchedules((l) => l.map((x) => (x.index === s.index ? { ...x, time } : x)))} />
            {/* Room only as read from the document (empty when the document has none); the user may correct it. */}
            <TextInput style={[ui.input, { paddingVertical: 8 }]} value={s.room} placeholder="Room (if on the timetable)" placeholderTextColor={palette.muted} editable={!s.created} onChangeText={(room) => setSchedules((l) => l.map((x) => (x.index === s.index ? { ...x, room, roomCheck: false } : x)))} accessibilityLabel="Room" />
            {/* Read from an image and not shaped like a room code: ask, don't guess. Editing it clears the note. */}
            {s.roomCheck && !s.created ? <Text style={[styles.meta, { color: palette.warning }]}>{t("docReview.checkRoom")}</Text> : null}
            <Text style={[styles.meta, { color: confColor(s.confidence) }]}>
              {s.existing ? "Already in your routines · " : s.created ? "Added · " : ""}Confidence {s.confidence}%{!s.days.length ? " · pick the days" : ""}
            </Text>
          </Card>
        ))
      ) : (
        <Text style={styles.meta}>No class schedules found.</Text>
      )}

      {hiddenCount ? <Text style={styles.meta}>{t("docInstr.hiddenNote", { count: String(hiddenCount) })}</Text> : null}
      {pending ? <Button title={`Create ${pending} selected`} onPress={() => void apply()} loading={applying} /> : null}

      {course && (course.code || course.name || course.topics.length) ? (
        <>
          <SectionTitle title="Course info" />
          <Card style={{ gap: 6 }}>
            <Text style={ui.h2}>{[course.code, course.name].filter(Boolean).join(" · ")}</Text>
            {course.instructor ? <Text style={ui.body}>Instructor: {course.instructor}</Text> : null}
            {course.prerequisites.length ? <Text style={ui.body}>Prerequisites: {course.prerequisites.join(", ")}</Text> : null}
            {course.topics.length ? <Text style={ui.body}>Topics: {course.topics.join(", ")}</Text> : null}
            {course.objectives.length ? <Text style={ui.body}>Objectives: {course.objectives.slice(0, 4).join("; ")}</Text> : null}
            {course.grading.length ? <Text style={ui.body}>Grading: {course.grading.map((g) => `${g.item} ${g.weight}%`).join(", ")}</Text> : null}
            {course.resources.length ? <Text style={ui.body}>Resources: {course.resources.slice(0, 4).join("; ")}</Text> : null}
            <Text style={styles.meta}>I'll use this as context — e.g. checking prerequisites when you plan related study.</Text>
          </Card>
        </>
      ) : null}
    </>
  );
}

const make_styles = ({ colors, palette, p }: Legacy) => StyleSheet.create({
  meta: { fontFamily: "Inter_400Regular", fontSize: 12, color: colors.textMuted },
  rowBetween: { flexDirection: "row", alignItems: "center", gap: 10 },
  box: { width: 26, height: 26, borderRadius: 7, borderWidth: 2, borderColor: colors.primary, alignItems: "center", justifyContent: "center" },
  boxOn: { backgroundColor: colors.primary },
});
