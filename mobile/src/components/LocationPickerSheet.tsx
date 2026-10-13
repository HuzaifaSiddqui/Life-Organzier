import * as Location from "expo-location";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useLocale } from "../i18n/LocaleProvider";
import { attachPlace, detachPlace, listPlaces, placeAt, savePlace, searchPlaces, updatePlace, type GeoResult } from "../services/locationsApi";
import { useTheme } from "../theme/ThemeProvider";
import type { SavedLocation, TaskLocation } from "../types/models";
import { Icon } from "./icons/Icon";
import { Button, Chip, Sheet, Text } from "./ui";

type Preset = SavedLocation["preset"];
type Selection = { savedLocationId: string | null; name: string; latitude: number | null; longitude: number | null; preset: Preset };
type Coords = { latitude: number; longitude: number };

const PRESETS: Array<{ key: Preset; label: "location.precise" | "location.nearby" | "location.area" }> = [
  { key: "PRECISE", label: "location.precise" },
  { key: "NEARBY", label: "location.nearby" },
  { key: "AREA", label: "location.area" },
];

/**
 * FR-LB-001 place picker: saved places, text search (backend → Nominatim), "Use current location",
 * manual name at the current position, then a radius preset. No map.
 *
 * - `taskId` (a synced task): the place is saved and attached here. Without it (a task not created yet,
 *   or editing from Saved places) the place is only saved and returned through `onLocationAdded`.
 * - `editing`: an existing link (task) or place (Saved places) opened for changes. Picking another place
 *   replaces the link; keeping it updates its name and radius.
 */
export function LocationPickerSheet({
  visible,
  onDismiss,
  taskId,
  editing,
  onLocationAdded,
}: {
  visible: boolean;
  onDismiss: () => void;
  taskId?: string | null;
  editing?: (TaskLocation | SavedLocation) | null;
  onLocationAdded: (place: SavedLocation, links: TaskLocation[] | null) => void;
}) {
  const { t } = useLocale();
  const { colors, spacing, radii, type } = useTheme();
  const [saved, setSaved] = useState<SavedLocation[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeoResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const [manual, setManual] = useState(false);
  const [locating, setLocating] = useState(false);
  const [hasAccess, setHasAccess] = useState(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const near = useRef<Coords | null>(null);

  const editingPlaceId = editing ? ("savedLocationId" in editing ? editing.savedLocationId : editing.id) : null;

  useEffect(() => {
    if (!visible) return;
    setQuery("");
    setResults(null);
    setShowFallback(false);
    setManual(false);
    setError(null);
    setSelection(editing ? { savedLocationId: editingPlaceId, name: editing.name, latitude: editing.latitude, longitude: editing.longitude, preset: editing.preset } : null);
    void (async () => {
      const places = await listPlaces().catch(() => [] as SavedLocation[]);
      setSaved(places);
      const granted = (await Location.getForegroundPermissionsAsync().catch(() => ({ granted: false }))).granted;
      setHasAccess(granted);
      // Bias search towards the user: last known position, else their saved "Home".
      const pos = granted ? await Location.getLastKnownPositionAsync({ maxAge: 3600000 }).catch(() => null) : null;
      const home = places.find((p) => p.name.trim().toLowerCase() === "home");
      near.current = pos ? pos.coords : home ? { latitude: home.latitude, longitude: home.longitude } : null;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Search: 500 ms after typing stops, at least 3 characters.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setResults(null);
      return;
    }
    let live = true;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await searchPlaces(q, near.current);
        if (!live) return;
        setResults(r);
        setShowFallback(r.length === 0);
        setError(null);
      } catch {
        if (live) setError(t("location.searchError"));
      } finally {
        if (live) setSearching(false);
      }
    }, 500);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, t]);

  const grant = async () => {
    const ok = (await Location.requestForegroundPermissionsAsync().catch(() => ({ granted: false }))).granted;
    setHasAccess(ok);
    return ok;
  };

  const currentPosition = async (): Promise<Coords | null> => {
    if (!hasAccess && !(await grant())) return null;
    setLocating(true);
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      return pos.coords;
    } catch {
      setError(t("location.error"));
      return null;
    } finally {
      setLocating(false);
    }
  };

  const useCurrent = async () => {
    const c = await currentPosition();
    if (!c) return;
    const found = await placeAt(c.latitude, c.longitude).catch(() => null);
    setSelection({ savedLocationId: null, name: found?.name ?? t("location.currentPlace"), latitude: c.latitude, longitude: c.longitude, preset: "NEARBY" });
  };

  const startManual = async () => {
    setManual(true);
    const c = hasAccess ? await currentPosition() : null;
    setSelection({ savedLocationId: null, name: query.trim(), latitude: c?.latitude ?? null, longitude: c?.longitude ?? null, preset: "NEARBY" });
  };

  /** Saves the place (and the link when there is a task), replacing the edited link if the place changed. */
  const finish = async (sel: Selection) => {
    if (sel.latitude === null || sel.longitude === null || !sel.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const original = saved.find((p) => p.id === sel.savedLocationId);
      let place: SavedLocation;
      if (sel.savedLocationId && original && (original.preset !== sel.preset || original.name !== sel.name.trim())) {
        place = await updatePlace(sel.savedLocationId, { name: sel.name.trim(), preset: sel.preset });
      } else if (sel.savedLocationId && original) {
        place = original;
      } else {
        place = await savePlace({ name: sel.name.trim(), latitude: sel.latitude, longitude: sel.longitude, preset: sel.preset });
      }
      let links: TaskLocation[] | null = null;
      if (taskId) {
        const link = editing && "savedLocationId" in editing ? editing : null;
        if (!link || link.savedLocationId !== place.id) {
          links = await attachPlace(taskId, place.id);
          if (link) links = await detachPlace(taskId, link.id);
        } else {
          // same link, place edited: refresh the link list so name/radius show the new values
          links = await attachPlace(taskId, place.id);
        }
      }
      onLocationAdded(place, links);
      onDismiss();
    } catch {
      setError(t("location.error"));
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = [styles.input, type.body, { color: colors.text, borderColor: colors.hairline, borderRadius: radii.md, paddingHorizontal: spacing.md }];
  const canSave = !!selection && selection.latitude !== null && selection.longitude !== null && selection.name.trim().length > 0;

  return (
    <Sheet visible={visible} onClose={onDismiss} title={editing ? t("location.edit") : t("location.add")}>
      <ScrollView style={{ maxHeight: 560 }} contentContainerStyle={{ gap: spacing.md, paddingTop: spacing.sm }} keyboardShouldPersistTaps="handled">
        {!selection || !selection.savedLocationId ? (
          <>
            <View style={[styles.searchRow, { borderColor: colors.hairline, borderRadius: radii.md, paddingHorizontal: spacing.md }]}>
              <Icon name="search" color={colors.textSecondary} />
              <TextInput
                value={query}
                onChangeText={(q) => {
                  setQuery(q);
                  setManual(false);
                }}
                placeholder={t("location.search")}
                placeholderTextColor={colors.textTertiary}
                style={[styles.flex, type.body, { color: colors.text, minHeight: 44 }]}
                accessibilityLabel={t("location.search")}
                autoCorrect={false}
              />
              {searching ? <ActivityIndicator color={colors.textSecondary} /> : null}
            </View>
            {query.trim().length > 0 && query.trim().length < 3 ? (
              <Text variant="caption" color="tertiary">
                {t("location.searchMin")}
              </Text>
            ) : null}

            <Button title={locating ? t("location.locating") : t("location.useCurrent")} kind="secondary" size="sm" icon={<Icon name="pin" color={colors.accent} size={18} />} loading={locating} onPress={() => void useCurrent()} style={{ alignSelf: "flex-start" }} />
            {!hasAccess ? (
              <Text variant="caption" color="secondary">
                {t("location.needAccess")}{" "}
                <Text variant="caption" color="accent" onPress={() => void grant()}>
                  {t("location.grant")}
                </Text>
              </Text>
            ) : null}
          </>
        ) : null}

        {saved.length && !selection ? (
          <View style={{ gap: spacing.sm }}>
            <Text variant="label" color="tertiary">
              {t("location.saved").toUpperCase()}
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
              {saved.map((p) => (
                // A saved place already has its radius: select and save straight away.
                <Chip key={p.id} label={p.name} onPress={() => void finish({ savedLocationId: p.id, name: p.name, latitude: p.latitude, longitude: p.longitude, preset: p.preset })} />
              ))}
            </ScrollView>
          </View>
        ) : null}

        {results && results.length && !selection ? (
          <View>
            <Text variant="label" color="tertiary" style={{ marginBottom: spacing.xs }}>
              {t("location.results").toUpperCase()}
            </Text>
            {results.map((r, i) => (
              <Pressable
                key={`${r.latitude},${r.longitude},${i}`}
                accessibilityRole="button"
                onPress={() => setSelection({ savedLocationId: null, name: r.name, latitude: r.latitude, longitude: r.longitude, preset: "NEARBY" })}
                style={({ pressed }) => [styles.result, { borderTopColor: colors.hairline, borderTopWidth: i ? StyleSheet.hairlineWidth : 0 }, pressed && { backgroundColor: colors.accentSoft }]}
              >
                <Text variant="bodyStrong" numberOfLines={1}>
                  {r.name}
                </Text>
                <Text variant="caption" color="secondary" numberOfLines={2}>
                  {r.displayName}
                </Text>
              </Pressable>
            ))}
            {!showFallback ? (
              <Text variant="caption" color="accent" onPress={() => setShowFallback(true)} style={{ marginTop: spacing.sm }}>
                {t("location.notFoundLink")}
              </Text>
            ) : null}
          </View>
        ) : null}

        {showFallback && !selection ? (
          <View style={{ gap: spacing.sm }}>
            <Text variant="callout" color="secondary">
              {t("location.notFound")}
            </Text>
            <View style={styles.row}>
              <Chip label={t("location.useCurrent")} onPress={() => void useCurrent()} />
              <Chip label={t("location.enterName")} onPress={() => void startManual()} />
            </View>
          </View>
        ) : null}

        {selection ? (
          <View style={{ gap: spacing.sm }}>
            <Text variant="label" color="tertiary">
              {t("location.nameLabel").toUpperCase()}
            </Text>
            <TextInput value={selection.name} onChangeText={(name) => setSelection({ ...selection, name })} style={inputStyle} accessibilityLabel={t("location.nameLabel")} autoFocus={manual} />
            {selection.latitude === null ? (
              <Text variant="caption" color="warning">
                {t("location.manualNeedsPosition")}
              </Text>
            ) : null}
            <View style={styles.row}>
              {PRESETS.map((p) => (
                <Chip key={p.key} small label={t(p.label)} selected={selection.preset === p.key} onPress={() => setSelection({ ...selection, preset: p.key })} />
              ))}
            </View>
            <Text variant="caption" color="secondary">
              {t("location.radiusHelp")}
            </Text>
            <Button title={t("location.save")} onPress={() => void finish(selection)} loading={busy} disabled={!canSave || busy} />
            {taskId && selection.savedLocationId ? (
              <Button title={t("location.search")} kind="ghost" size="sm" icon={<Icon name="search" color={colors.accent} size={18} />} onPress={() => setSelection(null)} />
            ) : null}
          </View>
        ) : null}

        {error ? (
          <Text variant="callout" color="danger">
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  searchRow: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: StyleSheet.hairlineWidth },
  input: { borderWidth: StyleSheet.hairlineWidth, minHeight: 44 },
  result: { paddingVertical: 10, gap: 2 },
});
