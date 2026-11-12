import Constants from "expo-constants";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { useLocale } from "../i18n/LocaleProvider";
import { api } from "../services/api";
import { clearServerAddress, getServerAddress, trySetServerAddress } from "../services/apiResolver";
import { useTheme } from "../theme/ThemeProvider";
import { parseServerAddress } from "../utils/serverAddress";
import { Button, Sheet, Text } from "./primitives";

/**
 * Settings, last line: "Life Organizer 1.0.0". A long-press opens the hidden Server address field (for the demo
 * release APK on a hotspot / LAN). The address is checked against /health before it is saved; Automatic clears it.
 */
export function VersionLine() {
  const { t } = useLocale();
  const { spacing } = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        onLongPress={() => setOpen(true)}
        delayLongPress={600}
        accessibilityRole="text"
        accessibilityHint={t("server.hint")}
        style={{ paddingVertical: spacing.lg, alignItems: "center" }}
      >
        <Text variant="caption" color="tertiary">
          {t("server.version", { version: Constants.expoConfig?.version ?? "" })}
        </Text>
      </Pressable>
      <ServerAddressSheet visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

function ServerAddressSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { t } = useLocale();
  const { colors, spacing, radii } = useTheme();
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: "danger" | "success" | "secondary" } | null>(null);

  useEffect(() => {
    if (!visible) return;
    setNote(null);
    void getServerAddress().then((s) => {
      setSaved(s);
      setDraft(s ?? "");
    });
  }, [visible]);

  const check = async () => {
    const base = parseServerAddress(draft);
    if (!base) return setNote({ text: t("server.invalid"), tone: "danger" });
    setBusy(true);
    setNote(null);
    try {
      if (await trySetServerAddress(base)) {
        setSaved(base);
        setNote({ text: t("server.saved", { url: base }), tone: "success" });
      } else {
        setNote({ text: t("server.unreachable", { url: base }), tone: "danger" });
      }
    } finally {
      setBusy(false);
    }
  };

  const automatic = async () => {
    await clearServerAddress();
    setSaved(null);
    setDraft("");
    setNote({ text: t("server.automatic"), tone: "secondary" });
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={t("server.title")}>
      <View style={{ gap: spacing.md }}>
        <Text variant="callout" color="secondary">
          {t("server.explain")}
        </Text>
        <Text variant="caption" color="tertiary">
          {t("server.current", { url: saved ?? `${api.defaults.baseURL ?? ""} (${t("server.auto")})` })}
        </Text>
        <TextInput
          value={draft}
          onChangeText={(v) => {
            setDraft(v);
            setNote(null);
          }}
          placeholder="192.168.43.10:5050"
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          accessibilityLabel={t("server.title")}
          style={[styles.input, { borderColor: colors.hairline, borderRadius: radii.md, color: colors.text, backgroundColor: colors.surface, paddingHorizontal: spacing.md }]}
        />
        {note ? (
          <Text variant="caption" color={note.tone} accessibilityLiveRegion="polite">
            {note.text}
          </Text>
        ) : null}
        <View style={[styles.row, { gap: spacing.sm }]}>
          <Button title={busy ? t("server.checking") : t("server.save")} loading={busy} disabled={!draft.trim()} onPress={() => void check()} />
          <Button title={t("server.reset")} kind="secondary" disabled={busy || !saved} onPress={() => void automatic()} />
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, minHeight: 48 },
  row: { flexDirection: "row", flexWrap: "wrap" },
});
