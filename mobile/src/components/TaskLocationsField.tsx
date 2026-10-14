import * as Location from "expo-location";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLocale } from "../i18n/LocaleProvider";
import { attachPlace, detachPlace } from "../services/locationsApi";
import { getLocationPermission, isLocationRemindersEnabled, setLocationRemindersEnabled, showLocationSnackbar } from "../services/locationReminders";
import { useTheme } from "../theme/ThemeProvider";
import type { SavedLocation, TaskLocation } from "../types/models";
import { distanceM, formatDistance } from "../utils/geofence";
import { Icon } from "./icons/Icon";
import { LocationActionSheet } from "./LocationActionSheet";
import { LocationPickerSheet } from "./LocationPickerSheet";
import { Button, Chip, IconButton, Text } from "./ui";

type Shown = { key: string; name: string; radiusM: number; latitude: number; longitude: number; link: TaskLocation | null; place: SavedLocation | null };

/**
 * FR-LB-001 location chips for a task (Pro only — the caller decides). With `taskId` (a synced task) links
 * are changed on the server straight away; without it (a task being created) chosen places are kept and
 * reported through `onPendingChange`, and the caller attaches them after the task is created.
 * `initial` is read once; give the component a `key` to reset it.
 */
export function TaskLocationsField({
  taskId,
  initial,
  onPendingChange,
  showDistance,
}: {
  taskId: string | null;
  initial: TaskLocation[];
  onPendingChange?: (places: SavedLocation[]) => void;
  showDistance?: boolean;
}) {
  const { t } = useLocale();
  const { colors, spacing } = useTheme();
  const [links, setLinks] = useState<TaskLocation[]>(initial);
  const [pending, setPending] = useState<SavedLocation[]>([]);
  const [picker, setPicker] = useState<{ editing: TaskLocation | SavedLocation | null } | null>(null);
  const [actions, setActions] = useState<TaskLocation | null>(null);
  const [ready, setReady] = useState(true); // reminders on and location allowed
  const [here, setHere] = useState<{ latitude: number; longitude: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const level = await getLocationPermission();
      setReady(level !== "denied" && (await isLocationRemindersEnabled()));
      if (showDistance && level !== "denied") {
        const pos = await Location.getLastKnownPositionAsync({ maxAge: 15 * 60000 }).catch(() => null);
        setHere(pos?.coords ?? null);
      }
    })();
  }, [showDistance]);

  const shown: Shown[] = taskId
    ? links.map((l) => ({ key: l.id, name: l.name, radiusM: l.radiusM, latitude: l.latitude, longitude: l.longitude, link: l, place: null }))
    : pending.map((p) => ({ key: p.id, name: p.name, radiusM: p.radiusM, latitude: p.latitude, longitude: p.longitude, link: null, place: p }));

  const setPendingList = (list: SavedLocation[]) => {
    setPending(list);
    onPendingChange?.(list);
  };

  /** Detach with a 5-second Undo (re-attaches the same place). */
  const removeLink = async (link: TaskLocation) => {
    setError(null);
    const id = taskId as string;
    try {
      setLinks(await detachPlace(id, link.id));
    } catch {
      setError(t("location.error"));
      return;
    }
    const at = Date.now();
    showLocationSnackbar({
      text: t("location.removed"),
      action: {
        label: t("location.undo"),
        onPress: () => {
          if (Date.now() - at <= 5000) void attachPlace(id, link.savedLocationId).then(setLinks, () => setError(t("location.error")));
        },
      },
    });
  };

  const remove = async (s: Shown) => {
    if (!s.link) return setPendingList(pending.filter((p) => p.id !== s.key));
    await removeLink(s.link);
  };

  const label = (s: Shown) =>
    showDistance && here ? t("location.away", { name: s.name, distance: formatDistance(distanceM(here, s)) }) : `${s.name} · ${s.radiusM}m`;

  return (
    <View style={{ gap: spacing.sm }}>
      {shown.map((s) => (
        <View key={s.key} style={styles.row}>
          <Chip label={label(s)} leading={<Icon name="pin" size={16} color={colors.accent} />} onPress={() => (s.link ? setActions(s.link) : setPicker({ editing: s.place }))} />
          <IconButton icon={<Icon name="close" size={18} color={colors.textSecondary} />} accessibilityLabel={t("location.remove", { name: s.name })} onPress={() => void remove(s)} />
        </View>
      ))}
      {shown.length === 0 ? (
        <Button title={t("location.add")} kind="secondary" size="sm" icon={<Icon name="pin" size={18} color={colors.accent} />} onPress={() => setPicker({ editing: null })} style={{ alignSelf: "flex-start" }} />
      ) : null}
      {shown.length > 0 && !ready ? (
        <Text variant="caption" color="secondary">
          {t("location.grantHint")}{" "}
          <Text variant="caption" color="accent" onPress={() => void setLocationRemindersEnabled(true).then((level) => setReady(level !== "denied"))}>
            {t("location.grant")}
          </Text>
        </Text>
      ) : null}
      {error ? (
        <Text variant="caption" color="danger">
          {error}
        </Text>
      ) : null}
      {taskId ? (
        <LocationActionSheet
          link={actions}
          taskId={taskId}
          onDismiss={() => setActions(null)}
          onLinksChanged={setLinks}
          onChange={(link) => {
            setActions(null);
            setPicker({ editing: link });
          }}
          onRemove={(link) => {
            setActions(null);
            void removeLink(link);
          }}
        />
      ) : null}
      <LocationPickerSheet
        visible={!!picker}
        onDismiss={() => setPicker(null)}
        taskId={taskId}
        editing={picker?.editing ?? null}
        onLocationAdded={(place, newLinks) => {
          if (newLinks) setLinks(newLinks);
          else {
            const editedId = picker?.editing && !("savedLocationId" in picker.editing) ? picker.editing.id : null;
            setPendingList([...pending.filter((p) => p.id !== place.id && p.id !== editedId), place]);
          }
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 4 },
});
