import { useCallback, useEffect, useState } from "react";
import { Alert, StyleSheet, Switch, TextInput, View } from "react-native";
import { usePreferences } from "../context/PreferencesContext";
import { useLocale } from "../i18n/LocaleProvider";
import type { StringKey } from "../i18n/strings";
import { apiErrorCode, isNetworkError } from "../services/api";
import { connectAgent, disconnectAgent, getAgentStatus, sendAgentTest, updateAgentSettings, type AgentStatus } from "../services/whatsappAgentApi";
import { useTheme } from "../theme/ThemeProvider";
import { agentChip, agentErrorKey, CHIP_ICON, CHIP_TONE, cleanKey, keyLooksValid, maskedKey } from "../utils/whatsappAgent";
import { Icon } from "./icons/Icon";
import { Button, Card, Chip, Skeleton, Text } from "./ui";

/**
 * Settings → WhatsApp Agent (docs/whatsapp-agent.md). The user creates an agent in WhatsApp, copies its API key and
 * pastes it here. The key is sent once and never shown again (only ••••last4). Explicit consent to the privacy
 * notice (not end-to-end encrypted, Meta handles the messages, availability depends on Meta). Pro only (Free users
 * see a locked card). The server does the rest: connection, polling, documents, voice notes and reminders are on by
 * default. Hidden when the server has the feature switched off. English + Roman Urdu.
 */
export function WhatsappAgentCard() {
  const { t } = useLocale();
  const { colors, spacing, radii, type } = useTheme();
  // Same Pro source as the rest of Settings, so switching to Pro on this screen unlocks the card at once.
  const { isPro } = usePreferences();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [key, setKey] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<null | "connect" | "test" | "settings">(null);
  const [note, setNote] = useState<{ text: string; tone: "secondary" | "danger" | "success" } | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await getAgentStatus());
    } catch {
      setStatus(null); // feature off on this server (404) or offline: the card stays hidden
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, isPro]); // re-read after a plan change (the server decides what Pro unlocks)

  const fail = (e: unknown) => setNote({ text: t(agentErrorKey(apiErrorCode(e), isNetworkError(e)) as StringKey), tone: "danger" });

  const connect = async () => {
    setBusy("connect");
    setNote(null);
    try {
      setStatus(await connectAgent(cleanKey(key)));
      setKey(""); // never kept on the phone either
      setConsent(false);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setNote(null);
    try {
      await sendAgentTest();
      setNote({ text: t("waAgent.testSent"), tone: "success" });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const change = async (patch: Parameters<typeof updateAgentSettings>[0]) => {
    setBusy("settings");
    setNote(null);
    try {
      setStatus(await updateAgentSettings(patch));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const disconnect = () =>
    Alert.alert(t("waAgent.disconnectTitle"), t("waAgent.disconnectBody"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("waAgent.disconnect"), style: "destructive", onPress: () => void disconnectAgent().then(load, fail) },
    ]);

  if (loading) return <Skeleton height={120} radius={radii.lg} />;
  if (!status?.enabled) return null;

  const chip = agentChip(status);
  const tone = CHIP_TONE[chip];
  const chipColor = tone === "neutral" ? colors.textSecondary : colors[tone].fg;
  const header = (
    <View style={styles.row}>
      <Text variant="bodyStrong" style={styles.flex}>
        {t("waAgent.title")}
      </Text>
      <Chip small label={t(`waAgent.chip.${chip}` as StringKey)} leading={<Icon name={CHIP_ICON[chip]} size={14} color={chipColor} />} />
    </View>
  );
  const noteLine = note ? (
    <Text variant="caption" color={note.tone} accessibilityLiveRegion="polite">
      {note.text}
    </Text>
  ) : null;

  if (!isPro) {
    return (
      <Card style={{ gap: spacing.sm }}>
        <View style={styles.row}>
          <Icon name="lock" color={colors.textSecondary} />
          <Text variant="bodyStrong" style={styles.flex}>
            {t("waAgent.proLocked")}
          </Text>
        </View>
        <Text variant="caption" color="secondary">
          {t("waAgent.body")}
        </Text>
      </Card>
    );
  }

  if (status.connected) {
    const mode = status.reminders.setting;
    return (
      <Card style={{ gap: spacing.md }}>
        {header}
        <Text variant="caption" color="secondary">
          {t("waAgent.keySaved", { key: maskedKey(status.keyLast4) })}
        </Text>
        {status.lastError ? (
          <View style={[styles.row, { backgroundColor: colors.warning.bg, borderRadius: radii.md, padding: spacing.sm }]}>
            <Icon name="info" size={16} color={colors.warning.fg} />
            <Text variant="caption" color="warning" style={styles.flex}>
              {t("waAgent.reminderFallback")}
            </Text>
          </View>
        ) : null}
        {status.hasChat ? null : (
          <View style={[styles.row, { backgroundColor: colors.info.bg, borderRadius: radii.md, padding: spacing.sm }]}>
            <Icon name="assistant" size={16} color={colors.info.fg} />
            <Text variant="caption" color="info" style={styles.flex}>
              {t("waAgent.sayHi")}
            </Text>
          </View>
        )}
        <Button title={t("waAgent.test")} kind="secondary" size="sm" loading={busy === "test"} onPress={() => void test()} style={styles.start} />

        <View style={{ gap: spacing.xs }}>
          <Text variant="callout">{t("waAgent.reminders")}</Text>
          {status.reminders.available ? (
            <View style={styles.wrap}>
              {(["OFF", "WHATSAPP", "BOTH"] as const).map((m) => (
                <Chip
                  key={m}
                  label={t(m === "OFF" ? "waAgent.remindersOff" : m === "WHATSAPP" ? "waAgent.remindersWhatsapp" : "waAgent.remindersBoth")}
                  selected={mode === m}
                  onPress={busy ? undefined : () => void change({ reminders: m })}
                />
              ))}
            </View>
          ) : (
            <Text variant="caption" color="secondary">
              {t("waAgent.remindersUnavailable")}
            </Text>
          )}
        </View>

        <View style={styles.row}>
          <View style={[styles.flex, { gap: spacing.xs }]}>
            <Text variant="callout">{t("waAgent.voice")}</Text>
            <Text variant="caption" color="secondary">
              {!status.voice.available ? t("waAgent.voiceUnavailable") : status.voice.ready ? t("waAgent.voiceHint") : t("waAgent.voiceNotReady")}
            </Text>
          </View>
          <Switch
            value={status.voice.setting && status.voice.available}
            disabled={!status.voice.available || busy !== null}
            onValueChange={(voice) => void change({ voice })}
            trackColor={{ true: colors.accent, false: colors.hairline }}
            accessibilityLabel={t("waAgent.voice")}
          />
        </View>
        {noteLine}
        <Button title={t("waAgent.disconnect")} kind="ghost" size="sm" onPress={disconnect} style={styles.start} />
      </Card>
    );
  }

  const reconnect = status.status === "NEEDS_RECONNECT" || status.status === "ERROR";
  const canConnect = consent && keyLooksValid(cleanKey(key));
  return (
    <Card style={{ gap: spacing.md }}>
      {header}
      <Text variant="caption" color="secondary">
        {reconnect ? t("waAgent.reconnectBody") : t("waAgent.body")}
      </Text>
      <View style={{ gap: spacing.xs }}>
        {(["waAgent.step1", "waAgent.step2", "waAgent.step3", "waAgent.step4"] as const).map((k) => (
          <Text key={k} variant="callout">
            {t(k)}
          </Text>
        ))}
      </View>
      <TextInput
        value={key}
        onChangeText={setKey}
        placeholder={t("waAgent.keyPlaceholder")}
        placeholderTextColor={colors.textTertiary}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        importantForAutofill="no"
        accessibilityLabel={t("waAgent.keyLabel")}
        style={[styles.input, type.body, { color: colors.text, borderColor: colors.hairline, borderRadius: radii.md, paddingHorizontal: spacing.md }]}
      />
      <View style={[{ gap: spacing.xs, backgroundColor: colors.info.bg, borderRadius: radii.md, padding: spacing.md }]}>
        <View style={styles.row}>
          <Icon name="lock" size={16} color={colors.info.fg} />
          <Text variant="callout" color="info">
            {t("waAgent.privacyTitle")}
          </Text>
        </View>
        {(["waAgent.privacy1", "waAgent.privacy2", "waAgent.privacy3"] as const).map((k) => (
          <Text key={k} variant="caption" color="info">
            {`• ${t(k)}`}
          </Text>
        ))}
      </View>
      <View style={styles.row}>
        <Text variant="callout" style={styles.flex}>
          {t("waAgent.consent")}
        </Text>
        <Switch value={consent} onValueChange={setConsent} trackColor={{ true: colors.accent, false: colors.hairline }} accessibilityLabel={t("waAgent.consent")} />
      </View>
      {noteLine}
      <Button title={reconnect ? t("waAgent.reconnect") : t("waAgent.connect")} disabled={!canConnect} loading={busy === "connect"} onPress={() => void connect()} />
      <View style={styles.row}>
        <Icon name="globe" size={16} color={colors.textTertiary} />
        <Text variant="caption" color="tertiary" style={styles.flex}>
          {t("waAgent.notAvailable")}
        </Text>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  flex: { flex: 1 },
  start: { alignSelf: "flex-start" },
  input: { minHeight: 48, borderWidth: StyleSheet.hairlineWidth },
});
