import { useState } from "react";
import { Alert, Linking, StyleSheet, View } from "react-native";
import { usePreferences } from "../context/PreferencesContext";
import { useLocale } from "../i18n/LocaleProvider";
import { startWhatsappLink, unlinkWhatsapp } from "../services/settingsApi";
import { useTheme } from "../theme/ThemeProvider";
import { Icon } from "./icons/Icon";
import { Button, Card, Text } from "./ui";

/**
 * FR-WA-001 Settings → WhatsApp. Pro only. Linking proves the number is yours: the app shows a code, you
 * send "LINK <code>" from WhatsApp, and the server links the number it came from. No free-text number field.
 */
export function WhatsappLinkCard() {
  const { t } = useLocale();
  const { colors, spacing, radii } = useTheme();
  const { isPro, whatsapp, reload } = usePreferences();
  const [link, setLink] = useState<{ code: string; botNumber: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const getCode = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await startWhatsappLink();
      setLink({ code: r.code, botNumber: r.botNumber });
    } catch {
      setNote(t("whatsapp.error"));
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    await reload();
    setNote(t("whatsapp.notLinkedYet")); // replaced by the linked view if it worked
  };

  const unlink = () =>
    Alert.alert(t("whatsapp.unlinkTitle"), t("whatsapp.unlinkBody"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("whatsapp.unlink"), style: "destructive", onPress: () => void unlinkWhatsapp().then(reload, () => setNote(t("whatsapp.error"))) },
    ]);

  if (!isPro) {
    return (
      <Card style={{ gap: spacing.sm }}>
        <View style={styles.row}>
          <Icon name="lock" color={colors.textSecondary} />
          <Text variant="bodyStrong">{t("whatsapp.proLocked")}</Text>
        </View>
        <Text variant="caption" color="secondary">
          {t("whatsapp.body")}
        </Text>
      </Card>
    );
  }

  if (whatsapp.linked) {
    return (
      <Card style={{ gap: spacing.sm }}>
        <View style={styles.row}>
          <Icon name="check" color={colors.success.fg} />
          <Text variant="bodyStrong" style={styles.flex}>
            {t("whatsapp.linked", { number: whatsapp.maskedNumber ?? "" })}
          </Text>
        </View>
        <Text variant="caption" color="secondary">
          {t("whatsapp.body")}
        </Text>
        <Button title={t("whatsapp.unlink")} kind="ghost" size="sm" onPress={unlink} style={{ alignSelf: "flex-start" }} />
      </Card>
    );
  }

  const message = link ? `LINK ${link.code}` : "";
  return (
    <Card style={{ gap: spacing.sm }}>
      <Text variant="caption" color="secondary">
        {t("whatsapp.body")}
      </Text>
      {link ? (
        link.botNumber ? (
          <View style={{ gap: spacing.sm }}>
            <Text variant="callout">{t("whatsapp.sendThis", { bot: link.botNumber })}</Text>
            <View style={[styles.code, { backgroundColor: colors.accentSoft, borderRadius: radii.md, padding: spacing.md }]}>
              <Text variant="title2" selectable accessibilityLabel={message.split("").join(" ")}>
                {message}
              </Text>
            </View>
            <Text variant="caption" color="tertiary">
              {t("whatsapp.expires")}
            </Text>
            <View style={styles.wrap}>
              <Button title={t("whatsapp.open")} size="sm" onPress={() => void Linking.openURL(`https://wa.me/${link.botNumber?.replace(/\D/g, "")}?text=${encodeURIComponent(message)}`)} />
              <Button title={t("whatsapp.check")} kind="secondary" size="sm" onPress={() => void check()} />
            </View>
          </View>
        ) : (
          <Text variant="caption" color="warning">
            {t("whatsapp.notConfigured")}
          </Text>
        )
      ) : null}
      {note ? (
        <Text variant="caption" color="secondary">
          {note}
        </Text>
      ) : null}
      <Button title={link ? t("whatsapp.newCode") : t("whatsapp.getCode")} kind={link ? "ghost" : "secondary"} size="sm" loading={busy} onPress={() => void getCode()} style={{ alignSelf: "flex-start" }} />
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  flex: { flex: 1 },
  code: { alignItems: "center" },
});
