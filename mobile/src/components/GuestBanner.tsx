import { StyleSheet, View } from "react-native";
import { useAuth } from "../context/AuthContext";
import { useLocale } from "../i18n/LocaleProvider";
import { openAppScreen } from "../navigation/navigationRef";
import { useTheme } from "../theme/ThemeProvider";
import { guestNudge } from "../utils/guest";
import { Icon } from "./icons/Icon";
import { Button, Card, Text } from "./ui";

/**
 * Guest mode (FR-OB-003 §4): "Data stored locally only. Create account to backup?" Shown on Home and Me while the
 * user is a guest; after 30 days it asks more firmly. Nothing for accounts.
 */
export function GuestBanner() {
  const { firebaseUser } = useAuth();
  const { t } = useLocale();
  const { colors, spacing } = useTheme();
  if (!firebaseUser?.isAnonymous) return null;
  const firm = guestNudge(firebaseUser.metadata.creationTime, Date.now()) === "firm";
  return (
    <Card tone={firm ? "warning" : undefined} style={{ gap: spacing.sm }}>
      <View style={styles.row}>
        <Icon name="info" size={18} color={firm ? colors.warning.fg : colors.textSecondary} />
        <Text variant="bodyStrong" style={styles.flex}>
          {t(firm ? "guest.banner.firmTitle" : "guest.banner.title")}
        </Text>
      </View>
      <Text variant="caption" color="secondary">
        {t("guest.banner.body")}
      </Text>
      <Button title={t("guest.createAccount")} size="sm" kind={firm ? "primary" : "secondary"} onPress={() => openAppScreen("CreateAccount")} style={styles.start} />
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  flex: { flex: 1 },
  start: { alignSelf: "flex-start" },
});
