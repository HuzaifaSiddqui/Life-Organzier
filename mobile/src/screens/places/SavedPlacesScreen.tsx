import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { Icon } from "../../components/icons/Icon";
import { LocationPickerSheet } from "../../components/LocationPickerSheet";
import { ScreenHeader } from "../../components/ScreenHeader";
import { EmptyState, ErrorState, IconButton, ListItem, Skeleton } from "../../components/ui";
import { useLocale } from "../../i18n/LocaleProvider";
import type { MainStackParamList } from "../../navigation/MainStack";
import { deletePlace, listPlaces } from "../../services/locationsApi";
import { useTheme } from "../../theme/ThemeProvider";
import type { SavedLocation } from "../../types/models";

type Props = NativeStackScreenProps<MainStackParamList, "SavedPlaces">;

const PRESET_KEY = { PRECISE: "location.precise", NEARBY: "location.nearby", AREA: "location.area" } as const;

/** FR-LB-001: the user's saved places — edit name/radius or delete (removes it from every task). */
export function SavedPlacesScreen({ navigation }: Props) {
  const { t } = useLocale();
  const { colors, spacing } = useTheme();
  const [places, setPlaces] = useState<SavedLocation[] | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const [editing, setEditing] = useState<SavedLocation | null>(null);

  const load = useCallback(async () => {
    try {
      setPlaces(await listPlaces());
      setFailed(null);
    } catch (e) {
      setFailed(e);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const confirmDelete = (p: SavedLocation) =>
    Alert.alert(t("places.deleteTitle", { name: p.name }), t("places.deleteBody"), [
      { text: t("places.cancel"), style: "cancel" },
      {
        text: t("places.delete"),
        style: "destructive",
        onPress: () => void deletePlace(p.id).then(load, setFailed),
      },
    ]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <ScreenHeader title={t("places.title")} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm }}>
        {failed ? (
          <ErrorState error={failed} onRetry={() => void load()} />
        ) : !places ? (
          [0, 1, 2].map((i) => <Skeleton key={i} height={56} />)
        ) : places.length === 0 ? (
          <EmptyState icon={<Icon name="pin" size={28} color={colors.textTertiary} />} title={t("places.title")} text={t("places.empty")} />
        ) : (
          places.map((p) => (
            <ListItem
              key={p.id}
              title={p.name}
              subtitle={`${t(PRESET_KEY[p.preset])} · ${t("places.used", { count: p.usageCount })}`}
              leading={<Icon name="pin" color={colors.accent} />}
              onPress={() => setEditing(p)}
              trailing={<IconButton icon={<Icon name="trash" color={colors.danger.fg} />} accessibilityLabel={t("places.deleteTitle", { name: p.name })} onPress={() => confirmDelete(p)} />}
            />
          ))
        )}
      </ScrollView>
      <LocationPickerSheet visible={!!editing} onDismiss={() => setEditing(null)} editing={editing} onLocationAdded={() => void load()} />
    </View>
  );
}
