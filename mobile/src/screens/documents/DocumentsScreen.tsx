import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as DocumentPicker from "expo-document-picker";
import * as Network from "expo-network";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Button, Card, Chip, ProgressBar, SectionTitle, Snackbar, TutorialTip, ui } from "../../components/ui";
import { colors, palette } from "../../constants/theme";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getApiErrorMessage } from "../../services/api";
import {
  applyDocument,
  deleteDocument,
  listDocuments,
  processText,
  uploadDocument,
  type DocType,
  type DocumentSummary,
  type ProcessResult,
} from "../../services/documentsApi";
import { WEEKDAYS_SHORT } from "../../utils/format";

type Props = NativeStackScreenProps<MainStackParamList, "Documents">;

const TYPES: Array<{ key: DocType; label: string }> = [
  { key: "SYLLABUS", label: "Syllabus" },
  { key: "SCHEDULE", label: "Schedule / timetable" },
  { key: "NOTES", label: "Notes" },
  { key: "OTHER", label: "Other" },
];
const LANGS = [
  { key: "eng", label: "English" },
  { key: "urd", label: "Urdu" },
  { key: "ara", label: "Arabic" },
];
const MAX_BYTES = 10 * 1024 * 1024;

type Picked = { uri: string; name: string; mimeType: string; size: number };
type EditableDeadline = { index: number; title: string; date: string; time: string; confidence: number; include: boolean; created: boolean; existing: boolean; assumedTime: boolean };
type EditableSchedule = { index: number; title: string; days: number[]; time: string; durationMinutes: number | null; confidence: number; include: boolean; created: boolean; existing: boolean };

function confColor(c: number): string {
  return c >= 90 ? palette.success : c >= 80 ? palette.warning : palette.danger;
}

export function DocumentsScreen({ navigation }: Props) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [docType, setDocType] = useState<DocType | null>(null);
  const [lang, setLang] = useState("eng");
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [deadlines, setDeadlines] = useState<EditableDeadline[]>([]);
  const [schedules, setSchedules] = useState<EditableSchedule[]>([]);
  const [pasteMode, setPasteMode] = useState(false);
  const [pasted, setPasted] = useState("");
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [usedBytes, setUsedBytes] = useState(0);
  const [applying, setApplying] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const [elapsed, setElapsed] = useState(0);
  const busy = progress !== null;
  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const id = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [busy]);
  const resultsY = useRef(0);

  const load = useCallback(async () => {
    try {
      const r = await listDocuments();
      setDocs(r.documents);
      setUsedBytes(r.usedBytes);
    } catch {
      // offline
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const showResult = (r: ProcessResult) => {
    setResult(r);
    // Fast extractions finish in under a second — say so and scroll to the results, or it looks like nothing happened.
    const { deadlines: d, schedules: s } = r.extracted;
    setToast(
      d.length || s.length
        ? `Found ${d.length} deadline${d.length === 1 ? "" : "s"} and ${s.length} schedule${s.length === 1 ? "" : "s"}`
        : "No deadlines or classes found in this file",
    );
    setTimeout(() => scrollRef.current?.scrollTo({ y: resultsY.current, animated: true }), 300);
    setDeadlines(
      r.extracted.deadlines.map((d) => ({
        index: d.index,
        title: d.title,
        date: d.date ?? "",
        time: d.time ?? "",
        confidence: d.confidence,
        include: !d.created && d.confidence >= 80 && Boolean(d.date),
        created: Boolean(d.created),
        existing: Boolean(d.existing),
        assumedTime: d.assumedTime,
      })),
    );
    setSchedules(
      r.extracted.schedules.map((s) => ({
        index: s.index,
        title: s.title,
        days: s.daysOfWeek,
        time: s.time ?? "",
        durationMinutes: s.durationMinutes,
        confidence: s.confidence,
        include: !s.created && s.daysOfWeek.length > 0,
        created: Boolean(s.created),
        existing: Boolean(s.existing),
      })),
    );
    void load();
  };

  const pick = async () => {
    const res = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf", "image/jpeg", "image/png", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      copyToCacheDirectory: true,
    });
    if (res.canceled || !res.assets[0]) return;
    const a = res.assets[0];
    if ((a.size ?? 0) > MAX_BYTES) {
      Alert.alert("File too large", "The maximum size is 10 MB per file.");
      return;
    }
    setPicked({ uri: a.uri, name: a.name, mimeType: a.mimeType ?? "application/octet-stream", size: a.size ?? 0 });
    setResult(null);
    setDocType(null);
  };

  const upload = async (language = lang) => {
    if (!picked || !docType) return;
    const net = await Network.getNetworkStateAsync();
    if (!net.isConnected || net.isInternetReachable === false) {
      setToast("No internet. Upload the file when you're online.");
      return;
    }
    setProgress(0);
    try {
      showResult(await uploadDocument(picked, docType, language, setProgress));
    } catch (e) {
      setToast(getApiErrorMessage(e, "Upload failed — please retry."));
    } finally {
      setProgress(null);
    }
  };

  const submitPaste = async () => {
    if (pasted.trim().length < 10 || !docType) return;
    setProgress(1);
    try {
      showResult(await processText(pasted, docType, "Pasted text"));
      setPasteMode(false);
      setPasted("");
    } catch (e) {
      setToast(getApiErrorMessage(e));
    } finally {
      setProgress(null);
    }
  };

  const apply = async () => {
    if (!result) return;
    const ds = deadlines.filter((d) => d.include && !d.created);
    const ss = schedules.filter((s) => s.include && !s.created);
    if (ds.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d.date))) {
      setToast("Each selected deadline needs a date (YYYY-MM-DD).");
      return;
    }
    setApplying(true);
    try {
      const r = await applyDocument(result.document.id, {
        deadlines: ds.map((d) => ({ title: d.title, date: d.date, time: d.time || null })),
        schedules: ss.filter((s) => s.days.length).map((s) => ({ title: s.title, daysOfWeek: s.days, time: s.time || null, durationMinutes: s.durationMinutes })),
      });
      setToast(`Created ${r.tasks.length} task${r.tasks.length === 1 ? "" : "s"} and ${r.routines.length} routine${r.routines.length === 1 ? "" : "s"}`);
      setDeadlines((l) => l.map((d) => (d.include ? { ...d, created: true, include: false } : d)));
      setSchedules((l) => l.map((s) => (s.include ? { ...s, created: true, include: false } : s)));
    } catch (e) {
      setToast(getApiErrorMessage(e));
    } finally {
      setApplying(false);
    }
  };

  const course = result?.extracted.course;
  const pending = deadlines.filter((d) => d.include && !d.created).length + schedules.filter((s) => s.include && !s.created).length;

  return (
    <View style={ui.screen}>
      <ScreenHeader title="Documents" onBack={() => navigation.goBack()} />
      <ScrollView ref={scrollRef} contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
        <TutorialTip id="documents" title="Upload a syllabus or timetable" text="1. Select a file  2. Choose its type  3. I'll extract deadlines and classes — high-confidence ones are added automatically, the rest you confirm." />

        <Card style={{ gap: 12 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button title={picked ? "Choose another file" : "Select file"} disabled={busy} onPress={() => void pick()} style={{ flex: 1 }} />
            <Button title="Paste text" kind="secondary" disabled={busy} onPress={() => setPasteMode((v) => !v)} />
          </View>
          <Text style={styles.meta}>PDF, JPG, PNG or DOCX · up to 10 MB · {(usedBytes / 1024 / 1024).toFixed(1)} MB used</Text>
          {picked ? <Text style={ui.body}>{picked.name} ({(picked.size / 1024).toFixed(0)} KB)</Text> : null}
          {pasteMode ? (
            <TextInput
              style={[ui.input, { minHeight: 120, textAlignVertical: "top" }]}
              value={pasted}
              onChangeText={setPasted}
              multiline
              placeholder="Paste syllabus or schedule text here"
              placeholderTextColor="#646A78"
            />
          ) : null}
          {picked || pasteMode ? (
            <>
              <Text style={ui.label}>What type of document is this?</Text>
              <View style={ui.wrap}>
                {TYPES.map((t) => (
                  <Chip key={t.key} small label={t.label} selected={docType === t.key} onPress={() => !busy && setDocType(t.key)} />
                ))}
              </View>
              {picked && /image/.test(picked.mimeType) ? (
                <>
                  <Text style={ui.label}>Language</Text>
                  <View style={ui.wrap}>
                    {LANGS.map((l) => (
                      <Chip key={l.key} small label={l.label} selected={lang === l.key} onPress={() => setLang(l.key)} />
                    ))}
                  </View>
                </>
              ) : null}
              {busy ? (
                <View style={styles.busy}>
                  <View style={styles.rowBetween}>
                    <ActivityIndicator color={palette.ai} />
                    <Text style={[ui.body, { flex: 1 }]}>
                      {progress! < 1 ? `Uploading… ${Math.round(progress! * 100)}%` : "Reading and extracting deadlines…"}
                    </Text>
                    <Text style={styles.meta}>{elapsed}s</Text>
                  </View>
                  {progress! < 1 ? <ProgressBar value={Math.round(progress! * 100)} color={palette.ai} /> : null}
                  {progress! >= 1 && elapsed >= 10 ? (
                    <Text style={styles.meta}>Photos are read with OCR, which can take up to a minute. Please keep the app open.</Text>
                  ) : null}
                </View>
              ) : (
                <>
                  {!docType ? <Text style={styles.meta}>Choose the document type above to enable Extract.</Text> : null}
                  <Button title="Extract" kind="tonal" disabled={!docType} onPress={() => void (pasteMode && !picked ? submitPaste() : upload())} />
                </>
              )}
            </>
          ) : null}
        </Card>

        {result ? (
          <>
            <View onLayout={(e) => (resultsY.current = e.nativeEvent.layout.y)} />
            {!result.extracted.deadlines.length && !result.extracted.schedules.length && !result.extracted.warning ? (
              <Card tone="warning" style={{ gap: 6 }}>
                <Text style={ui.body}>I couldn't find any dated deadlines or class times in this file.</Text>
                <Text style={styles.meta}>Make sure it has dates like "Oct 20, 2026" or class times like "Mon 9:00 AM", or try "Paste text".</Text>
              </Card>
            ) : null}
            {result.extracted.warning ? (
              <Card tone="warning" style={{ gap: 8 }}>
                <Text style={ui.body}>{result.extracted.warning}</Text>
                {result.extracted.needsLanguage ? (
                  <View style={ui.wrap}>
                    {LANGS.filter((l) => l.key !== "eng").map((l) => (
                      <Chip key={l.key} small label={`Retry as ${l.label}`} onPress={() => { setLang(l.key); void upload(l.key); }} />
                    ))}
                  </View>
                ) : (
                  <Text style={styles.meta}>Try uploading a clearer image — or review the results below anyway.</Text>
                )}
              </Card>
            ) : null}
            {result.extracted.method === "ocr" ? <Text style={styles.meta}>OCR confidence {result.extracted.ocrConfidence}%</Text> : null}

            <SectionTitle title={`Extracted deadlines (${deadlines.length})`} />
            {deadlines.length ? (
              deadlines.map((d, i) => (
                <Card key={d.index} style={{ gap: 8, opacity: d.created ? 0.7 : 1 }}>
                  <View style={styles.rowBetween}>
                    <Pressable
                      disabled={d.created}
                      onPress={() => setDeadlines((l) => l.map((x, j) => (j === i ? { ...x, include: !x.include } : x)))}
                      style={[styles.box, (d.include || d.created) && styles.boxOn]}
                    >
                      <Text style={{ color: "#fff", fontFamily: "Inter_700Bold" }}>{d.include || d.created ? "✓" : ""}</Text>
                    </Pressable>
                    <TextInput style={[ui.input, { flex: 1, paddingVertical: 8 }]} value={d.title} editable={!d.created} onChangeText={(title) => setDeadlines((l) => l.map((x, j) => (j === i ? { ...x, title } : x)))} />
                  </View>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <TextInput style={[ui.input, { flex: 1, paddingVertical: 8 }]} value={d.date} placeholder="YYYY-MM-DD" placeholderTextColor="#646A78" editable={!d.created} onChangeText={(date) => setDeadlines((l) => l.map((x, j) => (j === i ? { ...x, date } : x)))} />
                    <TextInput style={[ui.input, { width: 110, paddingVertical: 8 }]} value={d.time} placeholder="11:59 PM" placeholderTextColor="#646A78" editable={!d.created} onChangeText={(time) => setDeadlines((l) => l.map((x, j) => (j === i ? { ...x, time } : x)))} />
                  </View>
                  <Text style={[styles.meta, { color: confColor(d.confidence) }]}>
                    {d.existing ? "Already in your tasks · " : d.created ? "Added automatically · " : ""}Confidence {d.confidence}%
                    {d.assumedTime && !d.created ? " · time assumed 11:59 PM — OK?" : ""}
                    {!d.date ? " · too vague — enter a date" : ""}
                  </Text>
                </Card>
              ))
            ) : (
              <Text style={styles.meta}>No deadlines found.</Text>
            )}

            <SectionTitle title={`Extracted schedules (${schedules.length})`} />
            {schedules.length > 5 ? <Text style={styles.meta}>Found {schedules.length} classes — choose which to create.</Text> : null}
            {schedules.length ? (
              schedules.map((s, i) => (
                <Card key={s.index} style={{ gap: 8, opacity: s.created ? 0.7 : 1 }}>
                  <View style={styles.rowBetween}>
                    <Pressable
                      disabled={s.created}
                      onPress={() => setSchedules((l) => l.map((x, j) => (j === i ? { ...x, include: !x.include } : x)))}
                      style={[styles.box, (s.include || s.created) && styles.boxOn]}
                    >
                      <Text style={{ color: "#fff", fontFamily: "Inter_700Bold" }}>{s.include || s.created ? "✓" : ""}</Text>
                    </Pressable>
                    <TextInput style={[ui.input, { flex: 1, paddingVertical: 8 }]} value={s.title} editable={!s.created} onChangeText={(title) => setSchedules((l) => l.map((x, j) => (j === i ? { ...x, title } : x)))} />
                  </View>
                  <View style={ui.wrap}>
                    {WEEKDAYS_SHORT.map((label, d) => (
                      <Chip
                        key={label}
                        small
                        label={label}
                        selected={s.days.includes(d)}
                        onPress={s.created ? undefined : () => setSchedules((l) => l.map((x, j) => (j === i ? { ...x, days: x.days.includes(d) ? x.days.filter((y) => y !== d) : [...x.days, d].sort() } : x)))}
                      />
                    ))}
                  </View>
                  <TextInput style={[ui.input, { paddingVertical: 8 }]} value={s.time} placeholder="Time, e.g. 10 AM" placeholderTextColor="#646A78" editable={!s.created} onChangeText={(time) => setSchedules((l) => l.map((x, j) => (j === i ? { ...x, time } : x)))} />
                  <Text style={[styles.meta, { color: confColor(s.confidence) }]}>
                    {s.existing ? "Already in your routines · " : s.created ? "Added automatically · " : ""}Confidence {s.confidence}%{!s.days.length ? " · pick the days" : ""}
                  </Text>
                </Card>
              ))
            ) : (
              <Text style={styles.meta}>No class schedules found.</Text>
            )}

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
        ) : null}

        {docs.length ? (
          <>
            <SectionTitle title="Your documents" />
            {docs.map((d) => (
              <Card key={d.id} style={styles.docRow}>
                <View style={{ flex: 1 }}>
                  <Text style={ui.body} numberOfLines={1}>{d.fileName}</Text>
                  <Text style={styles.meta}>
                    {d.docType.toLowerCase()} · {new Date(d.createdAt).toLocaleDateString()} · {d.extracted?.deadlines.length ?? 0} deadlines · {d.extracted?.schedules.length ?? 0} schedules
                  </Text>
                </View>
                <Pressable
                  onPress={() =>
                    Alert.alert("Delete document?", "Tasks created from it are kept.", [
                      { text: "Cancel", style: "cancel" },
                      { text: "Delete", style: "destructive", onPress: () => void deleteDocument(d.id).then(load) },
                    ])
                  }
                  hitSlop={8}
                >
                  <Text style={{ color: palette.danger, fontFamily: "Inter_600SemiBold" }}>Delete</Text>
                </Pressable>
              </Card>
            ))}
          </>
        ) : null}
      </ScrollView>
      <Snackbar text={toast} onHide={() => setToast(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  meta: { fontFamily: "Inter_400Regular", fontSize: 12, color: colors.textMuted },
  busy: { gap: 8, padding: 12, borderRadius: 12, backgroundColor: palette.aiSoft },
  rowBetween: { flexDirection: "row", alignItems: "center", gap: 10 },
  box: { width: 26, height: 26, borderRadius: 7, borderWidth: 2, borderColor: colors.primary, alignItems: "center", justifyContent: "center" },
  boxOn: { backgroundColor: colors.primary },
  docRow: { flexDirection: "row", alignItems: "center", gap: 10 },
});
