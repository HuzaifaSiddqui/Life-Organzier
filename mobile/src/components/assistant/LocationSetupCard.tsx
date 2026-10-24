import { useEffect, useState } from "react";
import { StyleSheet, Switch, View } from "react-native";
import { useLocale } from "../../i18n/LocaleProvider";
import { locationRemindersReady, setLocationRemindersEnabled } from "../../services/locationReminders";
import { readTasks, syncNow } from "../../services/syncEngine";
import { useTheme } from "../../theme/ThemeProvider";
import { Icon } from "../icons/Icon";
import { LocationPickerSheet } from "../LocationPickerSheet";
import { Button, Card, ListItem, Text } from "../ui";

/**
 * In-chat setup for a task that names a place (FR-LB-001): the Location reminders toggle, which opens the
 * permission dialog, then "Set Home on the map" when the place isn't saved yet. Saving attaches it to the task.
 */
export function LocationSetupCard({ taskId, place, saved }: { taskId: string; place: string; saved: boolean }) {
  const { colors, spacing } = useTheme();
  const { t } = useLocale();
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const [placed, setPlaced] = useState(saved);
  const [picking, setPicking] = useState(false);

  // Live state: the card may be shown again later, after the toggle or the place was set elsewhere.
  useEffect(() => {
    void (async () => {
      setOn(await locationRemindersReady());
      if (!saved && (await readTasks()).find((x) => x.id === taskId)?.locations?.length) setPlaced(true);
    })();
  }, [saved, taskId]);

  const toggle = async (value: boolean) => {
    setBusy(true);
    const level = await setLocationRemindersEnabled(value);
    setBusy(false);
    const ready = value && level !== "denied";
    setDenied(value && level === "denied");
    setOn(ready);
    if (ready && !placed) setPicking(true); // straight to the map
  };

  return (
    <Card>
      <ListItem
        title={t("locationSetup.toggle")}
        subtitle={t("locationSetup.toggleHint", { place })}
        leading={<Icon name="pin" size={20} color={colors.accent} />}
        trailing={
          <Switch
            value={Boolean(on)}
            disabled={busy || on === null}
            onValueChange={(v) => void toggle(v)}
            trackColor={{ true: colors.accent, false: colors.hairline }}
            accessibilityLabel={t("locationSetup.toggle")}
          />
        }
      />
      <View style={[styles.below, { gap: spacing.sm }]}>
        {denied ? (
          <Text variant="caption" color="danger">
            {t("locationSetup.denied")}
          </Text>
        ) : null}
        {on && !placed ? (
          <Button title={t("locationSetup.setPlace", { place })} kind="secondary" size="sm" icon={<Icon name="pin" size={18} color={colors.accent} />} onPress={() => setPicking(true)} style={styles.start} />
        ) : null}
        {on && placed ? (
          <Text variant="caption" color="success">
            {t("locationSetup.done", { place })}
          </Text>
        ) : null}
      </View>
      <LocationPickerSheet
        visible={picking}
        onDismiss={() => setPicking(false)}
        taskId={taskId}
        initialName={place}
        onLocationAdded={() => {
          setPicking(false);
          setPlaced(true);
          void syncNow(); // the geofence follows the task cache
        }}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  below: { paddingHorizontal: 4 },
  start: { alignSelf: "flex-start" },
});
