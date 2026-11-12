import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLocale } from "../i18n/LocaleProvider";
import { subscribeAlerts, type AlertState } from "../services/dialog";
import { useTheme } from "../theme/ThemeProvider";
import { dialogButtons, dismissAction } from "../utils/alertButtons";
import { Button, Dialog, Text } from "./primitives";

/**
 * Renders `showAlert` (services/dialog.ts) on web / desktop, where Alert.alert does nothing. Mounted once at the root.
 * On the phone showAlert calls Alert.alert directly, so this never shows there.
 */
export function DialogHost() {
  const { t } = useLocale();
  const { spacing } = useTheme();
  const [state, setState] = useState<AlertState | null>(null);
  useEffect(() => subscribeAlerts(setState), []);
  if (!state) return null;
  const buttons = dialogButtons(state.buttons, t("common.ok"));
  const close = (run?: () => void) => {
    setState(null);
    run?.();
  };
  return (
    <Dialog visible onClose={() => close(dismissAction(state.buttons, state.options?.onDismiss))} title={state.title}>
      {state.message ? (
        <Text variant="body" color="secondary">
          {state.message}
        </Text>
      ) : null}
      <View style={[styles.actions, { gap: spacing.sm, marginTop: spacing.sm }]}>
        {buttons.map((b, i) => (
          <Button key={`${b.label}-${i}`} title={b.label} kind={b.kind} size="sm" onPress={() => close(b.onPress)} />
        ))}
      </View>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end" },
});
