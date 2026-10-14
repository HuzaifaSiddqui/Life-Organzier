import * as Location from "expo-location";
import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocale } from "../i18n/LocaleProvider";
import { usePlaceSearch } from "../hooks/usePlaceSearch";
import { getApiErrorMessage, isNetworkError } from "../services/api";
import { currentCoords } from "../services/locationReminders";
import { attachPlace, detachPlace, listPlaces, placeAt, savePlace, updatePlace } from "../services/locationsApi";
import { useTheme } from "../theme/ThemeProvider";
import type { SavedLocation, TaskLocation } from "../types/models";
import { Icon } from "./icons/Icon";
import { Button, Chip, IconButton, Text } from "./ui";

type Preset = SavedLocation["preset"];
type Selection = { savedLocationId: string | null; name: string; displayAddress: string | null; latitude: number | null; longitude: number | null; preset: Preset };

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
 * - `editing`: an existing link (task) or place (Saved places) opened for changes. On a task, picking
 *   another place replaces the link. In Saved places, "Change location" moves the place itself (same name,
 *   new position and address). Keeping it updates its name and radius.
 * - `initialName`: the name a newly found place is saved under (onboarding's "Home", "Office", …).
 *
 * A Modal with a fixed-height panel (85% of the screen) inside a KeyboardAvoidingView: the saved places and
 * the search field sit at the top of the panel, above where the keyboard opens, and results fill the rest.
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
  /** Saved places: the place being moved to a new position (keeps its id and name). */
  const [moveId, setMoveId] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [hasAccess, setHasAccess] = useState(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { results, searching, failed } = usePlaceSearch(query, saved);
  const showFallback = fallbackAsked || results?.length === 0;

  const editingPlaceId = editing ? ("savedLocationId" in editing ? editing.savedLocationId : editing.id) : null;

  useEffect(() => {
    if (!visible) return;
    setQuery("");
    setFallbackAsked(false);
    setManual(false);
    setMoveId(null);
    setError(null);
    setSelection(
      editing
        ? { savedLocationId: editingPlaceId, name: editing.name, displayAddress: editing.displayAddress ?? null, latitude: editing.latitude, longitude: editing.longitude, preset: editing.preset }
        : null,
    );
    void listPlaces()
      .catch(() => [] as SavedLocation[])
      .then(setSaved);
    void Location.getForegroundPermissionsAsync()
      .catch(() => ({ granted: false }))
      .then((p) => setHasAccess(p.granted));
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

  /** A found position: a new place, or (while moving a saved place) the same place somewhere else. */
  const pick = (r: { name: string; displayName: string | null; latitude: number; longitude: number }) =>
    setSelection({
      savedLocationId: moveId,
      name: moveId && editing ? editing.name : (initialName ?? r.name),
      displayAddress: r.displayName,
      latitude: r.latitude,
      longitude: r.longitude,
      preset: moveId && editing ? editing.preset : "NEARBY",
    });

  const useCurrent = async () => {
    const c = await currentPosition();
    if (!c) return;
    const found = await placeAt(c.latitude, c.longitude).catch(() => null);
    pick({ name: found?.name ?? t("location.currentPlace"), displayName: found?.displayName ?? null, latitude: c.latitude, longitude: c.longitude });
  };

  const startManual = async () => {
    setManual(true);
    const c = hasAccess ? await currentPosition() : null;
    setSelection({ savedLocationId: null, name: initialName ?? query.trim(), displayAddress: null, latitude: c?.latitude ?? null, longitude: c?.longitude ?? null, preset: "NEARBY" });
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

  const errorLine =
    error || failed ? (
      <Text variant="callout" color="danger">
        {error ?? t("location.searchError")}
      </Text>
    ) : null;

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
                { height: screenHeight * 0.85, backgroundColor: colors.sheet, borderTopStartRadius: radii.lg, borderTopEndRadius: radii.lg, paddingHorizontal: spacing.xl, paddingTop: spacing.sm, paddingBottom: Math.max(insets.bottom, spacing.lg), gap: spacing.md },
              ]}
            >
              <View style={[styles.handle, { backgroundColor: colors.hairline }]} />
              <View style={styles.header}>
                <Text variant="title2" accessibilityRole="header" style={styles.flex}>
                  {editing ? t("location.edit") : t("location.add")}
                </Text>
                <IconButton icon={<Icon name="close" color={colors.textSecondary} />} accessibilityLabel={t("common.close")} onPress={onDismiss} />
              </View>

              {selection ? (
                <ScrollView contentContainerStyle={{ gap: spacing.sm }} keyboardShouldPersistTaps="handled">
                  <Text variant="label" color="tertiary">
                    {t("location.nameLabel").toUpperCase()}
                  </Text>
                  <TextInput value={selection.name} onChangeText={(name) => setSelection({ ...selection, name })} style={inputStyle} accessibilityLabel={t("location.nameLabel")} autoFocus={manual} />
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
                    {t("location.radiusHelp")}
                  </Text>
                  {errorLine}
                  <Button title={t("location.save")} onPress={() => void finish(selection)} loading={busy} disabled={!canSave || busy} />
                  {/* Back to the search: on a task this picks another place; in Saved places it moves this one. */}
                  <Button
                    title={!taskId && selection.savedLocationId ? t("location.change") : t("location.search")}
                    kind="ghost"
                    size="sm"
                    icon={<Icon name="search" color={colors.accent} size={18} />}
                    onPress={() => {
                      if (!taskId && selection.savedLocationId) setMoveId(selection.savedLocationId);
                      setSelection(null);
                    }}
                  />
                </ScrollView>
              ) : (
                <>
                  {saved.length && !moveId ? (
                    <View style={{ gap: spacing.sm }}>
                      <Text variant="label" color="tertiary">
                        {t("location.saved").toUpperCase()}
                      </Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }} keyboardShouldPersistTaps="handled">
                        {saved.map((p) => (
                          // A saved place already has its radius: select and save straight away.
                          <Chip key={p.id} label={p.name} onPress={() => void finish({ savedLocationId: p.id, name: p.name, displayAddress: p.displayAddress ?? null, latitude: p.latitude, longitude: p.longitude, preset: p.preset })} />
                        ))}
                      </ScrollView>
                    </View>
                  ) : null}

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
                      autoFocus={false}
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
                  {errorLine}

                  <FlatList
                    style={styles.flex}
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
                        onPress={() => pick(r)}
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
                </>
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
});
