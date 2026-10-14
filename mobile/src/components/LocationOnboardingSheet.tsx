import { useCallback, useEffect, useState } from "react";
import { ScrollView } from "react-native";
import { useLocale } from "../i18n/LocaleProvider";
import { listPlaces } from "../services/locationsApi";
import { useTheme } from "../theme/ThemeProvider";
import type { SavedLocation } from "../types/models";
import { Icon, type IconName } from "./icons/Icon";
import { LocationPickerSheet } from "./LocationPickerSheet";
import { Button, ListItem, Sheet, Text } from "./ui";

type Slot = { saveAs: string; label: "onboarding.home" | "onboarding.university" | "onboarding.office"; icon: IconName; aliases: string[] };

/** Suggested places. Aliases match the backend's (locations/locationService.ts), so "Ghar" counts as Home. */
const SLOTS: Slot[] = [
  { saveAs: "Home", label: "onboarding.home", icon: "home", aliases: ["home", "ghar"] },
  { saveAs: "University", label: "onboarding.university", icon: "pin", aliases: ["university", "uni"] },
  { saveAs: "Office", label: "onboarding.office", icon: "pin", aliases: ["office", "daftar"] },
];

const slotOf = (p: SavedLocation) => SLOTS.find((s) => s.aliases.includes(p.name.trim().toLowerCase()));

/**
 * FR-LB-001 first-time setup, shown once after location reminders are turned on and allowed: Home,
 * University and Office, every other saved place, and "Add another place" (no limit). A row opens the
 * place picker, which saves the place at once, so there is nothing to lose by closing this sheet.
 */
export function LocationOnboardingSheet({ visible, onDismiss }: { visible: boolean; onDismiss: () => void }) {
  const { t } = useLocale();
  const { colors, spacing } = useTheme();
  const [saved, setSaved] = useState<SavedLocation[]>([]);
  const [picker, setPicker] = useState<{ place: SavedLocation | null; name?: string } | null>(null);

  const load = useCallback(() => void listPlaces().then(setSaved, () => undefined), []);
  useEffect(() => {
    if (visible) load();
  }, [visible, load]);

  const rows = [
    ...SLOTS.map((s) => ({ key: s.saveAs, title: t(s.label), icon: s.icon, name: s.saveAs, place: saved.find((p) => slotOf(p) === s) ?? null })),
    ...saved.filter((p) => !slotOf(p)).map((p) => ({ key: p.id, title: p.name, icon: "pin" as IconName, name: p.name, place: p })),
  ];

  return (
    <Sheet visible={visible} onClose={onDismiss} title={t("onboarding.placesTitle")}>
      <Text variant="body" color="secondary">
        {t("onboarding.placesBody")}
      </Text>
      <ScrollView style={{ maxHeight: 360 }}>
        {rows.map((r) => (
          <ListItem
            key={r.key}
            title={r.title}
            subtitle={r.place ? (r.place.displayAddress ?? t("onboarding.alreadySaved")) : t("onboarding.tapToSet")}
            leading={<Icon name={r.icon} color={colors.accent} />}
            trailing={<Icon name={r.place ? "check" : "chevron"} color={r.place ? colors.success.fg : colors.textTertiary} />}
            onPress={() => setPicker({ place: r.place, name: r.name })}
          />
        ))}
      </ScrollView>
      <Button title={t("onboarding.addAnother")} kind="secondary" size="sm" icon={<Icon name="plus" size={18} color={colors.accent} />} onPress={() => setPicker({ place: null })} style={{ alignSelf: "flex-start", marginBottom: spacing.sm }} />
      <Button title={t("onboarding.done")} onPress={onDismiss} />
      <LocationPickerSheet visible={!!picker} onDismiss={() => setPicker(null)} editing={picker?.place ?? null} initialName={picker?.name} onLocationAdded={load} />
    </Sheet>
  );
}
