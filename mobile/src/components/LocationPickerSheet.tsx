import * as Location from "expo-location";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocale } from "../i18n/LocaleProvider";
import { usePlaceSearch } from "../hooks/usePlaceSearch";
import { getApiErrorMessage, isNetworkError } from "../services/api";
import { currentCoords } from "../services/locationReminders";
import { attachPlace, detachPlace, listPlaces, placeAt, savePlace, updatePlace } from "../services/locationsApi";
import { useTheme } from "../theme/ThemeProvider";
import type { SavedLocation, TaskLocation } from "../types/models";
import { defaultCenter, initialCenter, presetRadius, type Center, type Coords, type MapMarker } from "../utils/map";
import { Icon } from "./icons/Icon";
import { MapPicker } from "./MapPicker";
import { Button, Chip, IconButton, Text } from "./ui";

type Preset = SavedLocation["preset"];
type Selection = { savedLocationId: string | null; name: string; displayAddress: string | null; latitude: number | null; longitude: number | null; preset: Preset };

/** Quick names, saved under the same names as onboarding (the backend treats "Ghar" as Home too). */
const NAMES: Array<{ saveAs: string; label: "onboarding.home" | "onboarding.university" | "onboarding.office" }> = [
  { saveAs: "Home", label: "onboarding.home" },
  { saveAs: "University", label: "onboarding.university" },
  { saveAs: "Office", label: "onboarding.office" },
];
/** Reverse lookup waits this long after a tap or drag ends (never runs while dragging). */
const LOOKUP_DELAY_MS = 600;

const PRESETS: Array<{ key: Preset; label: "location.precise" | "location.nearby" | "location.area" }> = [
  { key: "PRECISE", label: "location.precise" },
  { key: "NEARBY", label: "location.nearby" },
  { key: "AREA", label: "location.area" },
];

/**
 * FR-LB-001 place picker, map first: saved places, text search (backend → Nominatim) with results listed and
 * shown as pins, a map (MapPicker) where a tap or a dragged pin sets the exact spot and the radius circle shows
 * the preset, "Use current location", a manual name, and a radius preset. The map is optional: offline it
 * shows a note and everything else keeps working.
 *
 * - `taskId` (a synced task): the place is saved and attached here. Without it (a task not created yet,
 *   or editing from Saved places) the place is only saved and returned through `onLocationAdded`.
 * - `editing`: an existing link (task) or place (Saved places) opened for changes. On a task, picking
 *   another place replaces the link. In Saved places, "Change location" moves the place itself (same name,
 *   new position and address). Keeping it updates its name and radius.
 * - `initialName`: the name a newly found place is saved under (onboarding's "Home", "Office", …).
 *
 * A Modal with a fixed-height panel (85% of the screen) inside a KeyboardAvoidingView: the saved places and
 * the search field sit at the top of the panel, above where the keyboard opens. While the keyboard is up the
 * map collapses (it stays loaded) so the results, or the place details being typed, stay visible.
 *
 * Moving the pin or picking a result: in Saved places, while editing a place, it moves that place (same id and
 * name, new position). Anywhere else it is a new place; on a task it replaces the edited link when saved.
 */
export function LocationPickerSheet({
  visible,
  onDismiss,
  taskId,
  editing,
  initialName,
  onLocationAdded,
}: {
  visible: boolean;
  onDismiss: () => void;
  taskId?: string | null;
  editing?: (TaskLocation | SavedLocation) | null;
  initialName?: string;
  onLocationAdded: (place: SavedLocation, links: TaskLocation[] | null) => void;
}) {
  const { t } = useLocale();
  const { colors, spacing, radii, type } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const [saved, setSaved] = useState<SavedLocation[]>([]);
  const [query, setQuery] = useState("");
  const [fallbackAsked, setFallbackAsked] = useState(false);
  const [manual, setManual] = useState(false);
  const [locating, setLocating] = useState(false);
  const [hasAccess, setHasAccess] = useState(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [center, setCenter] = useState<Center>(() => defaultCenter(Intl.DateTimeFormat().resolvedOptions().timeZone));
  const [mapFailed, setMapFailed] = useState(false);
  /** The user typed or chose the name: a reverse lookup must not overwrite it. */
  const [nameEdited, setNameEdited] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const lookupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lookupSeq = useRef(0);
  const { results, searching, failed } = usePlaceSearch(query, saved);
  const showFallback = fallbackAsked || results?.length === 0;

  const editingPlaceId = editing ? ("savedLocationId" in editing ? editing.savedLocationId : editing.id) : null;
  /** Saved places screen, editing a place: a new position moves it (keeps its id and name). */
  const movingSavedPlace = !taskId && !!editingPlaceId;

  useEffect(() => {
    if (!visible) return;
    setQuery("");
    setFallbackAsked(false);
    setManual(false);
    setError(null);
    setMapFailed(false);
    setNameEdited(false);
    setSelection(
      editing
        ? { savedLocationId: editingPlaceId, name: editing.name, displayAddress: editing.displayAddress ?? null, latitude: editing.latitude, longitude: editing.longitude, preset: editing.preset }
        : null,
    );
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setCenter(editing ? { latitude: editing.latitude, longitude: editing.longitude, zoom: 16 } : defaultCenter(timeZone));
    void (async () => {
      const list = await listPlaces().catch(() => [] as SavedLocation[]);
      setSaved(list);
      const granted = (await Location.getForegroundPermissionsAsync().catch(() => ({ granted: false }))).granted;
      setHasAccess(granted);
      if (editing) return;
      // Where the map opens: current position, else the saved Home, else the timezone's default view.
      const pos = granted ? await Location.getLastKnownPositionAsync({ maxAge: 600000 }).catch(() => null) : null;
      setCenter(initialCenter({ current: pos?.coords ?? null, saved: list, timeZone }));
    })();
    const show = Keyboard.addListener("keyboardDidShow", () => setKeyboardOpen(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardOpen(false));
    return () => {
      show.remove();
      hide.remove();
      if (lookupTimer.current) clearTimeout(lookupTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const grant = async () => {
    const ok = (await Location.requestForegroundPermissionsAsync().catch(() => ({ granted: false }))).granted;
    setHasAccess(ok);
    return ok;
  };

  const currentPosition = async () => {
    if (!hasAccess && !(await grant())) return null;
    setLocating(true);
    const c = await currentCoords();
    setLocating(false);
    if (!c) setError(t("location.noFix"));
    return c;
  };

  /** Keeps a name the user typed, a place being moved, or onboarding's name; otherwise the found name. */
  const nameFor = (found: string | null, prev: Selection | null) => {
    if (movingSavedPlace && editing) return editing.name;
    if (nameEdited && prev?.name.trim()) return prev.name;
    return initialName ?? found ?? prev?.name ?? "";
  };

  /** A found position: a new place, or (while editing in Saved places) the same place somewhere else. */
  const pick = (r: { name: string; displayName: string | null; latitude: number; longitude: number }) => {
    setSelection((prev) => ({
      savedLocationId: movingSavedPlace ? editingPlaceId : null,
      name: nameFor(r.name, prev),
      displayAddress: r.displayName,
      latitude: r.latitude,
      longitude: r.longitude,
      preset: prev?.preset ?? (movingSavedPlace && editing ? editing.preset : "NEARBY"),
    }));
    setCenter({ latitude: r.latitude, longitude: r.longitude, zoom: 17 });
  };

  /** Name and address for a spot, then fill them in unless something newer happened meanwhile. */
  const lookUp = async (c: Coords) => {
    const seq = ++lookupSeq.current;
    const found = await placeAt(c.latitude, c.longitude).catch(() => null);
    if (seq !== lookupSeq.current) return;
    setSelection((prev) =>
      prev && prev.latitude === c.latitude && prev.longitude === c.longitude ? { ...prev, name: nameFor(found?.name ?? (prev.name || null), prev), displayAddress: found?.displayName ?? null } : prev,
    );
  };

  /** Map tap or the end of a pin drag: move the selection now, look the spot up after a pause. */
  const pinMoved = (c: Coords) => {
    setSelection((prev) => ({
      savedLocationId: movingSavedPlace ? editingPlaceId : null,
      name: nameFor(null, prev),
      displayAddress: prev?.displayAddress ?? null,
      latitude: c.latitude,
      longitude: c.longitude,
      preset: prev?.preset ?? (movingSavedPlace && editing ? editing.preset : "NEARBY"),
    }));
    if (lookupTimer.current) clearTimeout(lookupTimer.current);
    lookupSeq.current += 1; // an older lookup still in flight must not land on the new spot
    lookupTimer.current = setTimeout(() => void lookUp(c), LOOKUP_DELAY_MS);
  };

  const useCurrent = async () => {
    const c = await currentPosition();
    if (!c) return;
    const found = await placeAt(c.latitude, c.longitude).catch(() => null);
    pick({ name: found?.name ?? t("location.currentPlace"), displayName: found?.displayName ?? null, latitude: c.latitude, longitude: c.longitude });
  };

  const startManual = async () => {
    setManual(true);
    setNameEdited(Boolean(query.trim()));
    // The pin (if placed) is the spot; else the current position, else the middle of the map when it is showing.
    const c = selection?.latitude != null ? null : hasAccess ? await currentPosition() : null;
    const spot = selection?.latitude != null && selection.longitude != null ? { latitude: selection.latitude, longitude: selection.longitude } : (c ?? (mapFailed ? null : center));
    setSelection({ savedLocationId: null, name: initialName ?? query.trim(), displayAddress: null, latitude: spot?.latitude ?? null, longitude: spot?.longitude ?? null, preset: selection?.preset ?? "NEARBY" });
    if (c) setCenter({ ...c, zoom: 17 });
  };

  const markers = useMemo<MapMarker[]>(
    () => [
      ...saved.filter((p) => p.id !== selection?.savedLocationId).map((p) => ({ id: `s:${p.id}`, label: p.name, latitude: p.latitude, longitude: p.longitude, kind: "saved" as const })),
      ...(results ?? []).slice(0, 10).map((r, i) => ({ id: `r:${i}`, label: r.name, latitude: r.latitude, longitude: r.longitude, kind: "result" as const })),
    ],
    [saved, results, selection?.savedLocationId],
  );

  const markerTapped = (id: string) => {
    if (id.startsWith("r:")) {
      const r = results?.[Number(id.slice(2))];
      if (r) pick(r);
      return;
    }
    const p = saved.find((x) => `s:${x.id}` === id);
    if (p && !movingSavedPlace) {
      setSelection({ savedLocationId: p.id, name: p.name, displayAddress: p.displayAddress ?? null, latitude: p.latitude, longitude: p.longitude, preset: p.preset });
      setCenter({ latitude: p.latitude, longitude: p.longitude, zoom: 16 });
    }
  };

  /** Saves the place (and the link when there is a task), replacing the edited link if the place changed. */
  const finish = async (sel: Selection) => {
    if (sel.latitude === null || sel.longitude === null || !sel.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const original = saved.find((p) => p.id === sel.savedLocationId);
      let place: SavedLocation;
      const moved = !!original && (original.latitude !== sel.latitude || original.longitude !== sel.longitude);
      if (sel.savedLocationId && original && (moved || original.preset !== sel.preset || original.name !== sel.name.trim())) {
        place = await updatePlace(sel.savedLocationId, { name: sel.name.trim(), preset: sel.preset, ...(moved ? { latitude: sel.latitude, longitude: sel.longitude, displayAddress: sel.displayAddress } : {}) });
      } else if (sel.savedLocationId && original) {
        place = original;
      } else {
        place = await savePlace({ name: sel.name.trim(), displayAddress: sel.displayAddress, latitude: sel.latitude, longitude: sel.longitude, preset: sel.preset });
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
    } catch (e) {
      // Only a failed connection is a connection problem; otherwise say what the server said (e.g. the name is taken).
      console.warn("Could not save place", e);
      setError(isNetworkError(e) ? t("location.error") : getApiErrorMessage(e, t("location.error")));
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = [styles.input, type.body, { color: colors.text, borderColor: colors.hairline, borderRadius: radii.md, paddingHorizontal: spacing.md }];
  const canSave = !!selection && selection.latitude !== null && selection.longitude !== null && selection.name.trim().length > 0;
  const pin = selection && selection.latitude !== null && selection.longitude !== null ? { latitude: selection.latitude, longitude: selection.longitude } : null;
  const radiusM = presetRadius(selection?.preset);
  const typingSearch = keyboardOpen && searchFocused;

  const errorLine =
    error || failed ? (
      <Text variant="callout" color="danger">
        {error ?? t("location.searchError")}
      </Text>
    ) : null;

  const resultsList = (
    <FlatList
      style={typingSearch ? styles.flex : styles.results}
      data={results ?? []}
      keyExtractor={(r, i) => `${r.latitude},${r.longitude},${i}`}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      ListHeaderComponent={
        results?.length ? (
          <Text variant="label" color="tertiary" style={{ marginBottom: spacing.xs }}>
            {t("location.results").toUpperCase()}
          </Text>
        ) : null
      }
      renderItem={({ item: r, index: i }) => (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            pick(r);
            Keyboard.dismiss();
          }}
          style={({ pressed }) => [styles.result, { borderTopColor: colors.hairline, borderTopWidth: i ? StyleSheet.hairlineWidth : 0 }, pressed && { backgroundColor: colors.accentSoft }]}
        >
          <Text variant="bodyStrong" numberOfLines={1}>
            {r.name}
          </Text>
          <Text variant="caption" color="secondary" numberOfLines={2}>
            {r.displayName}
          </Text>
        </Pressable>
      )}
      ListFooterComponent={
        showFallback ? (
          <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
            <Text variant="callout" color="secondary">
              {t("location.notFound")}
            </Text>
            <View style={styles.row}>
              <Chip label={t("location.useCurrent")} onPress={() => void useCurrent()} />
              <Chip label={t("location.enterName")} onPress={() => void startManual()} />
            </View>
          </View>
        ) : results?.length ? (
          <Text variant="caption" color="accent" onPress={() => setFallbackAsked(true)} style={{ marginTop: spacing.sm }}>
            {t("location.notFoundLink")}
          </Text>
        ) : null
      }
    />
  );

  return (
    <Modal visible={visible} transparent animationType="slide" statusBarTranslucent navigationBarTranslucent onRequestClose={onDismiss}>
      <View style={styles.flex}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]} onPress={onDismiss} accessibilityRole="button" accessibilityLabel={t("common.close")} />
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.flex} pointerEvents="box-none">
          <View style={[styles.anchor, { paddingTop: insets.top }]} pointerEvents="box-none">
            <View
              accessibilityViewIsModal
              style={[
                styles.panel,
                { height: screenHeight * 0.85, backgroundColor: colors.sheet, borderTopStartRadius: radii.lg, borderTopEndRadius: radii.lg, paddingHorizontal: spacing.xl, paddingTop: spacing.sm, paddingBottom: Math.max(insets.bottom, spacing.lg), gap: spacing.sm },
              ]}
            >
              <View style={[styles.handle, { backgroundColor: colors.hairline }]} />
              <View style={styles.header}>
                <Text variant="title2" accessibilityRole="header" style={styles.flex}>
                  {editing ? t("location.edit") : t("location.add")}
                </Text>
                <IconButton icon={<Icon name="close" color={colors.textSecondary} />} accessibilityLabel={t("common.close")} onPress={onDismiss} />
              </View>

              {saved.length && !movingSavedPlace ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }} keyboardShouldPersistTaps="handled" style={styles.noGrow}>
                  {saved.map((p) => (
                    // A saved place already has its radius: select and save straight away.
                    <Chip key={p.id} label={p.name} onPress={() => void finish({ savedLocationId: p.id, name: p.name, displayAddress: p.displayAddress ?? null, latitude: p.latitude, longitude: p.longitude, preset: p.preset })} />
                  ))}
                </ScrollView>
              ) : null}

              <View style={[styles.searchRow, { borderColor: colors.hairline, borderRadius: radii.md, paddingHorizontal: spacing.md }]}>
                <Icon name="search" color={colors.textSecondary} />
                <TextInput
                  value={query}
                  onChangeText={(q) => {
                    setQuery(q);
                    setManual(false);
                  }}
                  onFocus={() => setSearchFocused(true)}
                  onBlur={() => setSearchFocused(false)}
                  placeholder={t("location.search")}
                  placeholderTextColor={colors.textTertiary}
                  style={[styles.flex, type.body, { color: colors.text, minHeight: 44 }]}
                  accessibilityLabel={t("location.search")}
                  autoCorrect={false}
                  autoFocus={false}
                />
                {searching ? <ActivityIndicator color={colors.textSecondary} /> : null}
              </View>
              {query.trim().length > 0 && query.trim().length < 3 ? (
                <Text variant="caption" color="tertiary">
                  {t("location.searchMin")}
                </Text>
              ) : null}

              {/* Search results: the whole space while typing a search; above the map otherwise. */}
              {typingSearch || (!keyboardOpen && (results?.length || showFallback)) ? resultsList : null}
              {/* Collapsed (still loaded) while the keyboard is up, so the field being typed in stays visible. */}
              <MapPicker
                center={center}
                pin={pin}
                radiusM={radiusM}
                markers={markers}
                onPinMoved={pinMoved}
                onMarkerTapped={markerTapped}
                onFailed={() => setMapFailed(true)}
                style={keyboardOpen ? styles.collapsed : mapFailed ? undefined : styles.map}
              />
              {!keyboardOpen && !mapFailed ? (
                <Text variant="caption" color="tertiary">
                  {t("location.mapHint")}
                </Text>
              ) : null}

              {typingSearch ? null : (
                <ScrollView style={keyboardOpen ? styles.flex : styles.details} contentContainerStyle={{ gap: spacing.sm }} keyboardShouldPersistTaps="handled">
                  <Button title={locating ? t("location.locating") : t("location.useCurrent")} kind="secondary" size="sm" icon={<Icon name="pin" color={colors.accent} size={18} />} loading={locating} onPress={() => void useCurrent()} style={{ alignSelf: "flex-start" }} />
                  {!hasAccess ? (
                    <Text variant="caption" color="secondary">
                      {t("location.needAccess")}{" "}
                      <Text variant="caption" color="accent" onPress={() => void grant()}>
                        {t("location.grant")}
                      </Text>
                    </Text>
                  ) : null}

                  {selection ? (
                    <>
                      <Text variant="label" color="tertiary">
                        {t("location.nameLabel").toUpperCase()}
                      </Text>
                      <TextInput
                        value={selection.name}
                        onChangeText={(name) => {
                          setNameEdited(true);
                          setSelection({ ...selection, name });
                        }}
                        style={inputStyle}
                        accessibilityLabel={t("location.nameLabel")}
                        autoFocus={manual}
                      />
                      {!movingSavedPlace ? (
                        <View style={styles.row} accessibilityLabel={t("location.nameAs")}>
                          {NAMES.map((n) => (
                            <Chip
                              key={n.saveAs}
                              small
                              label={t(n.label)}
                              selected={selection.name.trim().toLowerCase() === n.saveAs.toLowerCase()}
                              onPress={() => {
                                setNameEdited(true);
                                setSelection({ ...selection, name: n.saveAs });
                              }}
                            />
                          ))}
                        </View>
                      ) : null}
                      {selection.displayAddress ? (
                        <Text variant="caption" color="secondary" numberOfLines={2}>
                          {selection.displayAddress}
                        </Text>
                      ) : null}
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
                        {t("location.radiusMeters", { meters: radiusM })} · {t("location.radiusHelp")}
                      </Text>
                    </>
                  ) : null}
                  {errorLine}
                  {selection ? <Button title={t("location.save")} onPress={() => void finish(selection)} loading={busy} disabled={!canSave || busy} /> : null}
                </ScrollView>
              )}
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  anchor: { flex: 1, justifyContent: "flex-end" },
  panel: { maxHeight: "100%" }, // with the keyboard up the panel shrinks from the bottom; the search stays at the top
  handle: { alignSelf: "center", width: 36, height: 4, borderRadius: 2 },
  header: { flexDirection: "row", alignItems: "center" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  searchRow: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: StyleSheet.hairlineWidth },
  input: { borderWidth: StyleSheet.hairlineWidth, minHeight: 44 },
  result: { paddingVertical: 10, gap: 2 },
  results: { maxHeight: 140, flexGrow: 0 },
  map: { flex: 1, minHeight: 150 },
  collapsed: { height: 0, opacity: 0, borderWidth: 0 },
  details: { flexGrow: 0, maxHeight: "48%" },
  noGrow: { flexGrow: 0 },
});
