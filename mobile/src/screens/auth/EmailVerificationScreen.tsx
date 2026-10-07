import { reload, sendEmailVerification, signOut } from "firebase/auth";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { GradientPrimaryButton } from "../../components/GradientPrimaryButton";
import { LogoMark } from "../../components/branding/LogoMark";
import { useAuth } from "../../context/AuthContext";
import { auth } from "../../lib/firebase";
import { colors, radii, shadow, palette } from "../../constants/theme";

/** Shown from root when Firebase user exists but email is not verified yet. */
export function EmailVerificationScreen() {
  const { firebaseUser, refreshProfile } = useAuth();
  const email = firebaseUser?.email ?? "your email";
  const [busy, setBusy] = useState<"resend" | "reload" | "signout" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clearFeedback = () => {
    setMessage(null);
    setError(null);
  };

  const onResend = useCallback(async () => {
    const u = auth.currentUser;
    if (!u) return;
    clearFeedback();
    setBusy("resend");
    try {
      await sendEmailVerification(u);
      setMessage("We sent another link. Check your inbox and spam folder.");
    } catch (e: unknown) {
      const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code?: string }).code) : "";
      if (code === "auth/too-many-requests") {
        setError("Please wait a few minutes before requesting another email.");
      } else {
        setError("Could not send the email. Check your connection and try again.");
      }
    } finally {
      setBusy(null);
    }
  }, []);

  const onVerified = useCallback(async () => {
    const u = auth.currentUser;
    if (!u) return;
    clearFeedback();
    setBusy("reload");
    try {
      await reload(u);
      if (!auth.currentUser?.emailVerified) {
        setError("That address is not verified yet. Open the link in the email we sent, then try again.");
        return;
      }
      setMessage("Email verified. Loading your account…");
      await refreshProfile();
    } catch {
      setError("Could not refresh your account. Try again.");
    } finally {
      setBusy(null);
    }
  }, [refreshProfile]);

  const onSignOut = useCallback(async () => {
    clearFeedback();
    setBusy("signout");
    try {
      await signOut(auth);
    } catch {
      setError("Could not sign out. Try again.");
    } finally {
      setBusy(null);
    }
  }, []);

  const openMailApp = useCallback(() => {
    void Linking.openURL(`mailto:${email}`).catch(() => {});
  }, [email]);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.logoWrap}>
          <LogoMark size={56} />
        </View>
        <Text style={styles.title}>Verify your email</Text>
        <Text style={styles.body}>
          We sent a verification link to{" "}
          <Text style={styles.email}>{email}</Text>. Open that email on this device, tap the link, then
          return here and press “I’ve verified my email”.
        </Text>

        <View style={styles.card}>
          <GradientPrimaryButton
            title="I’ve verified my email"
            onPress={() => void onVerified()}
            loading={busy === "reload"}
            disabled={busy !== null}
          />
          <Pressable
            style={({ pressed }) => [styles.secondaryBtn, pressed && { opacity: 0.92 }]}
            onPress={() => void onResend()}
            disabled={busy !== null}
          >
            {busy === "resend" ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <Text style={styles.secondaryBtnText}>Resend verification email</Text>
            )}
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.linkBtn, pressed && { opacity: 0.85 }]}
            onPress={openMailApp}
          >
            <Text style={styles.linkBtnText}>Open mail app</Text>
          </Pressable>
        </View>

        {message ? <Text style={styles.success}>{message}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          style={({ pressed }) => [styles.signOut, pressed && { opacity: 0.85 }]}
          onPress={() => void onSignOut()}
          disabled={busy !== null}
        >
          {busy === "signout" ? (
            <ActivityIndicator color={colors.textMuted} />
          ) : (
            <Text style={styles.signOutText}>Use a different account</Text>
          )}
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {
    paddingHorizontal: 24,
    paddingBottom: 32,
    maxWidth: 440,
    width: "100%",
    alignSelf: "center",
  },
  logoWrap: {
    alignItems: "center",
    marginTop: 16,
    marginBottom: 20,
  },
  title: {
    fontSize: 24,
    fontFamily: "Inter_600SemiBold",
    color: colors.text,
    textAlign: "center",
    marginBottom: 12,
  },
  body: {
    fontSize: 16,
    lineHeight: 24,
    color: colors.textMuted,
    textAlign: "center",
    marginBottom: 24,
  },
  email: {
    fontFamily: "Inter_600SemiBold",
    color: colors.text,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.xl,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 12,
    ...shadow,
  },
  secondaryBtn: {
    minHeight: 48,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  secondaryBtnText: {
    fontSize: 16,
    fontFamily: "Inter_500Medium",
    color: colors.primary,
  },
  linkBtn: {
    paddingVertical: 8,
    alignItems: "center",
  },
  linkBtnText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: colors.primaryDark,
  },
  success: {
    marginTop: 16,
    fontSize: 15,
    color: palette.success,
    textAlign: "center",
    lineHeight: 22,
  },
  error: {
    marginTop: 16,
    fontSize: 15,
    color: colors.danger,
    textAlign: "center",
    lineHeight: 22,
  },
  signOut: {
    marginTop: 28,
    alignItems: "center",
    paddingVertical: 12,
  },
  signOutText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: colors.textMuted,
  },
});
