import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useAuth } from "../context/AuthContext";
import { useLocale } from "../i18n/LocaleProvider";
import { showAlert } from "../services/dialog";
import { switchFromGuest } from "../services/googleCredential";
import { googleSignInAvailable, signInWithGoogle } from "../services/googleSignIn";
import { useTheme } from "../theme/ThemeProvider";
import { Button, Text } from "./ui";

/**
 * "Continue with Google" (Welcome, Login, a guest's Create account). Hidden when the build has no Google client ID.
 * A guest keeps their data (the Google account is linked to the guest account). If that Google account already has
 * a Life Organizer account, the guest is asked before switching to it (their guest data would be deleted).
 */
export function GoogleSignInButton({ onDone }: { onDone?: () => void }) {
  const { t } = useLocale();
  const { spacing } = useTheme();
  const { refreshAuthUser } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!googleSignInAvailable()) return null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await signInWithGoogle();
      if (r.kind === "linked") {
        refreshAuthUser();
        onDone?.();
      } else if (r.kind === "signed_in") {
        onDone?.();
      } else if (r.kind === "already_used") {
        showAlert(t("google.usedTitle"), t("google.usedBody"), [
          { text: t("common.cancel"), style: "cancel" },
          {
            text: t("google.switch"),
            style: "destructive",
            onPress: () =>
              void switchFromGuest(r.credential).then(
                () => onDone?.(),
                () => setError(t("google.failed")),
              ),
          },
        ]);
      }
    } catch {
      setError(t("google.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: spacing.xs, alignSelf: "stretch" }}>
      <Button title={t("google.continue")} kind="secondary" loading={busy} onPress={() => void run()} accessibilityLabel={t("google.continue")} style={styles.full} />
      {error ? (
        <Text variant="caption" color="danger" center>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  full: { alignSelf: "stretch" },
});
