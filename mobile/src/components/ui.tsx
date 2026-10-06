import { type ReactNode, useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { colors, palette, radii, shadowTile } from "../constants/theme";
import { usePreferences } from "../context/PreferencesContext";
import { getSyncStatus, retrySync, subscribeSync, type SyncStatus } from "../services/syncEngine";

export function Card({ children, style, tone }: { children: ReactNode; style?: StyleProp<ViewStyle>; tone?: "ai" | "warning" | "danger" | "success" }) {
  const toneStyle =
    tone === "ai"
      ? { backgroundColor: palette.aiSoft, borderColor: "#DDD6FE" }
      : tone === "warning"
        ? { backgroundColor: palette.warningSoft, borderColor: "#FDE68A" }
        : tone === "danger"
          ? { backgroundColor: palette.dangerSoft, borderColor: "#FECACA" }
          : tone === "success"
            ? { backgroundColor: palette.successSoft, borderColor: "#BBF7D0" }
            : null;
  return <View style={[styles.card, toneStyle, style]}>{children}</View>;
}

export function SectionTitle({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {right}
    </View>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  tone,
  small,
  onLongPress,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  tone?: "primary" | "danger" | "ai";
  small?: boolean;
  onLongPress?: () => void;
}) {
  const accent = tone === "danger" ? palette.danger : tone === "ai" ? palette.ai : colors.primary;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress && !onLongPress}
      style={({ pressed }) => [
        styles.chip,
        small && styles.chipSmall,
        selected && { backgroundColor: accent, borderColor: accent },
        tone && !selected && { borderColor: accent },
        pressed && { opacity: 0.85 },
      ]}
    >
      <Text style={[styles.chipText, small && { fontSize: 12 }, selected && { color: "#fff" }, tone && !selected && { color: accent }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Button({
  title,
  onPress,
  kind = "primary",
  loading,
  disabled,
  style,
}: {
  title: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "danger" | "ai" | "ghost";
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const bg =
    kind === "primary" ? colors.primary : kind === "danger" ? palette.danger : kind === "ai" ? palette.ai : kind === "ghost" ? "transparent" : colors.surface;
  const fg = kind === "secondary" || kind === "ghost" ? colors.text : "#fff";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg },
        kind === "secondary" && { borderWidth: 1, borderColor: colors.border },
        (disabled || loading) && { opacity: 0.6 },
        pressed && { opacity: 0.85 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={fg} /> : <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function ProgressBar({ value, color = colors.primary, height = 6 }: { value: number; color?: string; height?: number }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <View style={[styles.track, { height, borderRadius: height }]}>
      <View style={{ width: `${v}%`, backgroundColor: color, height, borderRadius: height }} />
    </View>
  );
}

/** "I'm 82% sure…" — confidence is always shown to the user (FR-PL-002 §4). */
export function ConfidenceMeter({ value, label }: { value: number; label?: string }) {
  const pct = Math.round(value * (value <= 1 ? 100 : 1));
  const color = pct >= 80 ? palette.success : pct >= 60 ? palette.ai : palette.warning;
  return (
    <View style={{ gap: 4 }}>
      <View style={styles.rowBetween}>
        <Text style={styles.meta}>{label ?? "Confidence"}</Text>
        <Text style={[styles.meta, { color, fontWeight: "700" }]}>{pct}%</Text>
      </View>
      <ProgressBar value={pct} color={color} height={5} />
    </View>
  );
}

export function EmptyState({ icon, title, text, action }: { icon: string; title: string; text?: string; action?: ReactNode }) {
  return (
    <View style={styles.empty}>
      <Text style={{ fontSize: 34 }}>{icon}</Text>
      <Text style={styles.emptyTitle}>{title}</Text>
      {text ? <Text style={styles.emptyText}>{text}</Text> : null}
      {action}
    </View>
  );
}

export function HighlightText({ text, query, style, numberOfLines }: { text: string; query: string; style?: StyleProp<import("react-native").TextStyle>; numberOfLines?: number }) {
  const q = query.trim();
  if (!q) return <Text style={style} numberOfLines={numberOfLines}>{text}</Text>;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {parts.map((p, i) =>
        p.toLowerCase() === q.toLowerCase() ? (
          <Text key={i} style={styles.highlight}>
            {p}
          </Text>
        ) : (
          p
        ),
      )}
    </Text>
  );
}

/** Offline / syncing / failed indicator with manual retry (FR-EH-001, FR-EH-002). */
export function SyncBadge() {
  const [s, setS] = useState<SyncStatus>(getSyncStatus());
  useEffect(() => subscribeSync(setS), []);
  if (s.online && !s.failed && !s.syncing && s.pending === 0) return null;
  const label = !s.online
    ? `Offline${s.pending ? ` · ${s.pending} change${s.pending === 1 ? "" : "s"} saved on phone` : ""}`
    : s.failed
      ? "Sync failed. Retry?"
      : s.syncing
        ? "Syncing…"
        : `${s.pending} change${s.pending === 1 ? "" : "s"} waiting to sync`;
  return (
    <Pressable onPress={() => void retrySync()} style={[styles.syncBadge, s.failed && { backgroundColor: palette.dangerSoft, borderColor: "#FECACA" }, !s.online && { backgroundColor: "#F1F5F9" }]}>
      <View style={[styles.dot, { backgroundColor: !s.online ? palette.muted : s.failed ? palette.danger : palette.warning }]} />
      <Text style={styles.syncText}>{label}</Text>
      {s.failed || !s.online ? <Text style={[styles.syncText, { color: colors.primary, fontWeight: "700" }]}>Retry</Text> : null}
    </Pressable>
  );
}

/** First-use tooltip per feature (FR-OB-002) with "Don't show again". */
export function TutorialTip({ id, title, text }: { id: string; title: string; text: string }) {
  const { settings, markTutorialSeen } = usePreferences();
  const [hidden, setHidden] = useState(false);
  if (!settings || !settings.tutorialsEnabled || settings.tutorialsSeen.includes(id) || hidden) return null;
  return (
    <Card tone="ai" style={{ gap: 6 }}>
      <Text style={[styles.sectionTitle, { fontSize: 15, color: palette.aiDark }]}>💡 {title}</Text>
      <Text style={styles.body}>{text}</Text>
      <View style={[styles.row, { justifyContent: "flex-end", gap: 8 }]}>
        <Chip small label="Got it" onPress={() => setHidden(true)} />
        <Chip small tone="ai" label="Don't show again" onPress={() => void markTutorialSeen(id)} />
      </View>
    </Card>
  );
}

/** "?" help button for each feature (FR-OB-002 §4). */
export function HelpButton({ title, text, example }: { title: string; text: string; example?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} hitSlop={10} style={styles.help} accessibilityLabel={`Help: ${title}`}>
        <Text style={styles.helpText}>?</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <Text style={styles.sectionTitle}>{title}</Text>
            <Text style={styles.body}>{text}</Text>
            {example ? (
              <View style={styles.example}>
                <Text style={styles.meta}>Example</Text>
                <Text style={styles.body}>{example}</Text>
              </View>
            ) : null}
            <Button title="Close" kind="secondary" onPress={() => setOpen(false)} />
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

export function Toast({ text, tone = "success", onHide, action }: { text: string | null; tone?: "success" | "warning" | "danger"; onHide: () => void; action?: { label: string; onPress: () => void } }) {
  useEffect(() => {
    if (!text) return;
    const t = setTimeout(onHide, action ? 6000 : 3500);
    return () => clearTimeout(t);
  }, [text, onHide, action]);
  if (!text) return null;
  return (
    <View style={[styles.toast, tone === "warning" && { backgroundColor: "#92400E" }, tone === "danger" && { backgroundColor: "#991B1B" }]}>
      <Text style={styles.toastText}>{text}</Text>
      {action ? (
        <Pressable onPress={action.onPress} hitSlop={8}>
          <Text style={[styles.toastText, { fontWeight: "800", textDecorationLine: "underline" }]}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export const ui = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 14, paddingBottom: 120 },
  h1: { fontSize: 26, fontWeight: "800", color: colors.text },
  h2: { fontSize: 18, fontWeight: "700", color: colors.text },
  body: { fontSize: 15, color: colors.text, lineHeight: 21 },
  meta: { fontSize: 13, color: colors.textMuted },
  row: { flexDirection: "row", alignItems: "center" },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    backgroundColor: colors.surface,
    color: colors.text,
  },
  label: { fontSize: 13, fontWeight: "600", color: colors.textMuted, marginBottom: 6 },
  error: { color: palette.danger, fontSize: 14 },
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    ...shadowTile,
  },
  sectionRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 4 },
  sectionTitle: { fontSize: 17, fontWeight: "700", color: colors.text },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    maxWidth: 260,
  },
  chipSmall: { paddingHorizontal: 10, paddingVertical: 5 },
  chipText: { fontSize: 13, fontWeight: "600", color: colors.text },
  button: { minHeight: 46, borderRadius: radii.md, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  buttonText: { fontSize: 15, fontWeight: "700" },
  track: { backgroundColor: "#E2E8F0", overflow: "hidden", width: "100%" },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  meta: { fontSize: 12, color: colors.textMuted },
  empty: { alignItems: "center", padding: 24, gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: colors.text },
  emptyText: { fontSize: 14, color: colors.textMuted, textAlign: "center" },
  highlight: { backgroundColor: "#FEF08A", color: colors.text },
  syncBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radii.pill,
    backgroundColor: palette.warningSoft,
    borderWidth: 1,
    borderColor: "#FDE68A",
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  syncText: { fontSize: 12, color: colors.text, fontWeight: "600" },
  body: { fontSize: 14, color: colors.text, lineHeight: 20 },
  row: { flexDirection: "row", alignItems: "center" },
  help: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  helpText: { fontWeight: "800", color: colors.textMuted },
  backdrop: { flex: 1, backgroundColor: "rgba(15,23,42,0.45)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.surface, padding: 20, borderTopLeftRadius: 24, borderTopRightRadius: 24, gap: 12 },
  example: { backgroundColor: colors.surfaceSoft, borderRadius: radii.md, padding: 12, gap: 4 },
  toast: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 96,
    backgroundColor: "#14532D",
    borderRadius: radii.md,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    zIndex: 20,
  },
  toastText: { color: "#fff", fontSize: 14, flexShrink: 1 },
});
