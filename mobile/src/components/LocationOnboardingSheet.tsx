import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { usePlaceSearch } from "../hooks/usePlaceSearch";
import { useLocale } from "../i18n/LocaleProvider";
import { currentCoords } from "../services/locationReminders";
import { listPlaces, placeAt, savePlace } from "../services/locationsApi";
import { useTheme } from "../theme/ThemeProvider";
import type { SavedLocation } from "../types/models";
import { Icon, type IconName } from "./icons/Icon";
import { Button, Sheet, Text } from "./ui";

type Picked = { name: string; displayAddress: string | null; latitude: number; longitude: number };
type Slot = { key: "home" | "university"; saveAs: string; label: "onboarding.home" | "onboarding.university"; icon: IconName; aliases: string[] };

const SLOTS: Slot[] = [
  { key: "home", saveAs: "Home", label: "onboarding.home", icon: "home", aliases: ["home", "ghar"] },
  { key: "university", saveAs: "University", label: "onboarding.university", icon: "pin", aliases: ["university", "uni"] },
];

/** One place row: current location or a search; shows the address once chosen, or "Already saved". */
function PlaceRow({ slot, saved, existing, picked, onPick }: { slot: Slot; saved: SavedLocation[]; existing: SavedLocation | null; picked: Picked | null; onPick: (p: Picked) => void }) {
  const { t } = useLocale();
  const { colors, spacing, radii, type } = useTheme();
  const [query, setQuery] = useState("");
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { results, searching } = usePlaceSearch(query, saved);
  const label = t(slot.label);

  const useCurrent = async () => {
    setLocating(true);
    setError(null);
    const c = await currentCoords();
    if (!c) {
      setLocating(false);
      setError(t("location.noFix"));
      return;
    }
    const found = await placeAt(c.latitude, c.longitude).catch(() => null);
    setLocating(false);
    onPick({ name: slot.saveAs, displayAddress: found?.displayName ?? null, latitude: c.latitude, longitude: c.longitude });
  };

  const address = existing?.displayAddress ?? picked?.displayAddress ?? null;
  return (
    <View style={{ gap: spacing.sm }}>
      <View style={styles.head}>
        <Icon name={slot.icon} color={colors.accent} />
        <Text variant="bodyStrong" style={styles.flex}>
          {label}
        </Text>
        {existing ? (
          <Text variant="caption" color="success">
            {t("onboarding.alreadySaved")}
          </Text>
        ) : null}
      </View>
      {existing || picked ? (
        address ? (
          <Text variant="caption" color="secondary" numberOfLines={2}>
            {address}
          </Text>
        ) : null
      ) : (
        <>
          <Button title={locating ? t("location.locating") : t("location.useCurrent")} kind="secondary" size="sm" loading={locating} icon={<Icon name="pin" size={18} color={colors.accent} />} onPress={() => void useCurrent()} style={{ alignSelf: "flex-start" }} />
          <View style={[styles.search, { borderColor: colors.hairline, borderRadius: radii.md, paddingHorizontal: spacing.md }]}>
            <Icon name="search" color={colors.textSecondary} size={18} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t("onboarding.searchFor", { place: label })}
              placeholderTextColor={colors.textTertiary}
              style={[styles.flex, type.body, { color: colors.text, minHeight: 44 }]}
              accessibilityLabel={t("onboarding.searchFor", { place: label })}
              autoCorrect={false}
            />
            {searching ? <ActivityIndicator color={colors.textSecondary} /> : null}
          </View>
          {(results ?? []).slice(0, 3).map((r, i) => (
            <Pressable
              key={`${r.latitude},${r.longitude}`}
              accessibilityRole="button"
              onPress={() => onPick({ name: slot.saveAs, displayAddress: r.displayName, latitude: r.latitude, longitude: r.longitude })}
              style={({ pressed }) => [styles.result, { borderTopColor: colors.hairline, borderTopWidth: i ? StyleSheet.hairlineWidth : 0 }, pressed && { backgroundColor: colors.accentSoft }]}
            >
              <Text variant="callout" numberOfLines={2}>
                {r.displayName}
              </Text>
            </Pressable>
          ))}
          {error ? (
            <Text variant="caption" color="danger">
              {error}
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
}

/**
 * FR-LB-001 first-time setup, shown once after location reminders are turned on and allowed:
 * one sheet with Home and University. Places that already exist are shown as saved.
 */
export function LocationOnboardingSheet({ visible, onDismiss }: { visible: boolean; onDismiss: () => void }) {
  const { t } = useLocale();
  const { spacing } = useTheme();
  const [saved, setSaved] = useState<SavedLocation[]>([]);
  const [picked, setPicked] = useState<Record<string, Picked | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setPicked({});
    setError(null);
    void listPlaces().then(setSaved, () => setSaved([]));
  }, [visible]);

  const existingFor = (slot: Slot) => saved.find((p) => slot.aliases.includes(p.name.trim().toLowerCase())) ?? null;
  const toSave = SLOTS.filter((s) => !existingFor(s) && picked[s.key]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const s of toSave) await savePlace({ ...(picked[s.key] as Picked), preset: "NEARBY" });
      onDismiss();
    } catch {
      setError(t("location.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={onDismiss} title={t("onboarding.placesTitle")}>
      <ScrollView style={{ maxHeight: 600 }} contentContainerStyle={{ gap: spacing.lg }} keyboardShouldPersistTaps="handled">
        <Text variant="body" color="secondary">
          {t("onboarding.placesBody")}
        </Text>
        {SLOTS.map((slot) => (
          <PlaceRow key={slot.key} slot={slot} saved={saved} existing={existingFor(slot)} picked={picked[slot.key] ?? null} onPick={(p) => setPicked((cur) => ({ ...cur, [slot.key]: p }))} />
        ))}
        {error ? (
          <Text variant="callout" color="danger">
            {error}
          </Text>
        ) : null}
        <Button title={t("onboarding.save")} onPress={() => void save()} loading={busy} disabled={busy || toSave.length === 0} />
        <Button title={t("onboarding.skip")} kind="ghost" size="sm" onPress={onDismiss} />
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  search: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: StyleSheet.hairlineWidth },
  result: { paddingVertical: 8 },
});
