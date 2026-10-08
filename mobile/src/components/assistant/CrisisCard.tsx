import { Linking, StyleSheet, View } from "react-native";
import { useLocale } from "../../i18n/LocaleProvider";
import { useTheme } from "../../theme/ThemeProvider";
import type { CrisisPayload } from "../../types/models";
import { Button, Card, Text } from "../ui";

/**
 * Crisis resources card. Numbers and their labels come from the server (backend CRISIS_RESOURCES,
 * already localised); never hard-code helpline numbers in the app.
 */
export function CrisisCard({ resources, onClearTasks }: { resources: CrisisPayload["resources"]; onClearTasks?: () => void }) {
  const { t } = useLocale();
  const { spacing } = useTheme();
  return (
    <Card tone="danger" style={{ gap: spacing.md }}>
      <Text variant="bodyStrong" accessibilityRole="header">
        {t("crisis.title")}
      </Text>
      <View style={styles.buttons}>
        {resources.map((r) => (
          <Button
            key={r.phone}
            title={t("crisis.call", { label: r.label, phone: r.phone })}
            accessibilityLabel={t("crisis.callA11y", { label: r.label, phone: r.phone })}
            kind="danger"
            size="sm"
            onPress={() => void Linking.openURL(`tel:${r.phone}`)}
          />
        ))}
      </View>
      <Text variant="caption" color="secondary">
        {t("crisis.footer")}
      </Text>
      {onClearTasks ? <Button title={t("crisis.clearTasks")} kind="secondary" size="sm" onPress={onClearTasks} /> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  buttons: { gap: 8, alignItems: "flex-start" },
});
