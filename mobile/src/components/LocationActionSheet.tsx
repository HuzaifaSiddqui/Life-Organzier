import * as Location from "expo-location";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLocale } from "../i18n/LocaleProvider";
import { attachPlace, updatePlace } from "../services/locationsApi";
import { useTheme } from "../theme/ThemeProvider";
import type { SavedLocation, TaskLocation } from "../types/models";
import { distanceM, formatDistance } from "../utils/geofence";
import { Button, Chip, Sheet, Text } from "./ui";

const PRESETS: Array<{ key: SavedLocation["preset"]; label: "location.precise" | "location.nearby" | "location.area" }> = [
  { key: "PRECISE", label: "location.precise" },
  { key: "NEARBY", label: "location.nearby" },
  { key: "AREA", label: "location.area" },
];

/**
 * FR-LB-001 compact sheet for a task's location: name, address and distance as the confirmation (no map),
 * radius presets that save at once, and Change / Remove.
 */
export function LocationActionSheet({
  link,
  taskId,
  onDismiss,
  onLinksChanged,
  onChange,
  onRemove,
}: {
  link: TaskLocation | null;
  taskId: string;
  onDismiss: () => void;
  onLinksChanged: (links: TaskLocation[]) => void;
  onChange: (link: TaskLocation) => void;
  onRemove: (link: TaskLocation) => void;
}) {
  const { t } = useLocale();
  const { spacing } = useTheme();
  const [preset, setPreset] = useState<SavedLocation["preset"]>(link?.preset ?? "NEARBY");
  const [distance, setDistance] = useState<number | null>(null);
  const [note, setNote] = useState<{ text: string; tone: "success" | "danger" } | null>(null);

  useEffect(() => {
    if (!link) return;
    setPreset(link.preset);
    setNote(null);
    setDistance(null);
    void (async () => {
      if (!(await Location.getForegroundPermissionsAsync().catch(() => ({ granted: false }))).granted) return;
      const pos = await Location.getLastKnownPositionAsync({ maxAge: 15 * 60000 }).catch(() => null);
      if (pos) setDistance(distanceM(pos.coords, link));
    })();
  }, [link]);

  if (!link) return null;

  const pickRadius = async (next: SavedLocation["preset"]) => {
    if (next === preset) return;
    const before = preset;
    setPreset(next);
    try {
      await updatePlace(link.savedLocationId, { preset: next });
      onLinksChanged(await attachPlace(taskId, link.savedLocationId)); // refreshes the cached links (already attached: no-op)
      setNote({ text: t("location.radiusUpdated"), tone: "success" });
    } catch {
      setPreset(before);
      setNote({ text: t("location.error"), tone: "danger" });
    }
  };

  return (
    <Sheet visible onClose={onDismiss} title={link.name}>
      <View style={{ gap: spacing.md }}>
        {link.displayAddress || distance !== null ? (
          <View style={{ gap: spacing.xs }}>
            {link.displayAddress ? (
              <Text variant="callout" color="secondary" numberOfLines={3}>
                {link.displayAddress}
              </Text>
            ) : null}
            {distance !== null ? (
              <Text variant="caption" color="tertiary">
                {t("location.awayOnly", { distance: formatDistance(distance) })}
              </Text>
            ) : null}
          </View>
        ) : null}
        <View style={{ gap: spacing.sm }}>
          <View style={styles.row}>
            {PRESETS.map((p) => (
              <Chip key={p.key} small label={t(p.label)} selected={preset === p.key} onPress={() => void pickRadius(p.key)} />
            ))}
          </View>
          <Text variant="caption" color="secondary">
            {t("location.radiusHelp")}
          </Text>
          {note ? (
            <Text variant="caption" color={note.tone}>
              {note.text}
            </Text>
          ) : null}
        </View>
        <View style={styles.row}>
          <Button title={t("location.change")} kind="secondary" size="sm" onPress={() => onChange(link)} style={styles.flex} />
          <Button title={t("location.removeFromTask")} kind="ghost" size="sm" onPress={() => onRemove(link)} style={styles.flex} />
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  flex: { flex: 1 },
});
