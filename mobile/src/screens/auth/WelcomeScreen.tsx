import { GoogleSignInButton } from "../../components/GoogleSignInButton";
import { useEffect, useState } from "react";
import { useLocale } from "../../i18n/LocaleProvider";
import { continueAsGuest, guestModeAvailable } from "../../services/guest";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { LinearGradient } from "expo-linear-gradient";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LogoMark } from "../../components/branding/LogoMark";
import { blue, colors, radii, shadow } from "../../constants/theme";
import type { AuthStackParamList } from "../../navigation/AuthStack";

type Props = NativeStackScreenProps<AuthStackParamList, "Welcome">;

const features = [
  "Natural language task capture",
  "Smart AI categorization",
  "Voice & chat interfaces",
  "Seamless scheduling",
  "Personalized reminders",
  "One-touch organization",
];

export function WelcomeScreen({ navigation }: Props) {
  const { t } = useLocale();
  // Guest mode (FR-OB-003): offered only when the server has GUEST_MODE on.
  const [guestOn, setGuestOn] = useState(false);
  const [guestBusy, setGuestBusy] = useState(false);
  const [guestError, setGuestError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void guestModeAvailable().then((on) => live && setGuestOn(on));
    return () => {
      live = false;
    };
  }, []);
  const startGuest = async () => {
    setGuestBusy(true);
    setGuestError(null);
    try {
      await continueAsGuest();
    } catch {
      setGuestError(t("guest.continueFailed"));
    } finally {
      setGuestBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom", "left", "right"]}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.card}>
          <View style={styles.headerRow}>
            <LogoMark size={72} />
            <View style={styles.headerTitles}>
              <Text style={styles.appName}>Life Organizer</Text>
              <Text style={styles.tagline}>Smart Productivity Assistant</Text>
            </View>
          </View>

          <Text style={styles.headline}>Your AI-Powered Life Assistant</Text>
          <Text style={styles.subcopy}>Capture tasks naturally, organize effortlessly</Text>

          <View style={styles.featureList}>
            {features.map((line) => (
              <View key={line} style={styles.featureRow}>
                <View style={styles.bullet} />
                <Text style={styles.featureText}>{line}</Text>
              </View>
            ))}
          </View>

          <View style={styles.actions}>
            <Pressable
              style={({ pressed }) => [styles.primaryWrap, pressed && styles.btnPressed]}
              onPress={() => navigation.navigate("Login")}
            >
              <LinearGradient
                colors={[colors.text, colors.text]}
                start={{ x: 0, y: 0 }}
                end={{ x: 0, y: 1 }}
                style={styles.primaryGrad}
              >
                <Text style={styles.primaryText}>Log in</Text>
              </LinearGradient>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.secondary, pressed && styles.btnPressed]}
              onPress={() => navigation.navigate("Signup")}
            >
              <Text style={styles.secondaryText}>Create account</Text>
            </Pressable>
            <GoogleSignInButton />
            {guestOn ? (
              <Pressable
                style={({ pressed }) => [styles.guest, pressed && styles.btnPressed]}
                onPress={() => void startGuest()}
                disabled={guestBusy}
                accessibilityRole="button"
                accessibilityHint={t("guest.continueHint")}
              >
                <Text style={styles.guestText}>{guestBusy ? "…" : t("guest.continue")}</Text>
              </Pressable>
            ) : null}
            {guestError ? <Text style={styles.guestError}>{guestError}</Text> : null}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  guest: { alignItems: "center", justifyContent: "center", minHeight: 48 },
  guestText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: colors.textMuted, textDecorationLine: "underline" },
  guestError: { fontSize: 13, color: colors.danger, textAlign: "center" },
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 20,
    paddingVertical: 24,
  },
  card: {
    width: "100%",
    maxWidth: 400,
    alignSelf: "center",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radii.xl,
    paddingHorizontal: 24,
    paddingTop: 28,
    paddingBottom: 26,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    marginBottom: 18,
    width: "100%",
  },
  headerTitles: {
    flex: 1,
    justifyContent: "center",
    minWidth: 0,
  },
  appName: {
    fontSize: 22,
    fontFamily: "Inter_600SemiBold",
    color: colors.primary,
    letterSpacing: -0.3,
  },
  tagline: {
    marginTop: 4,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textMuted,
    fontFamily: "Inter_500Medium",
  },
  badge: {
    alignSelf: "center",
    backgroundColor: blue[50],
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radii.pill,
    marginBottom: 20,
  },
  badgeText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: blue[700],
    letterSpacing: 0.2,
  },
  headline: {
    alignSelf: "stretch",
    fontSize: 24,
    fontFamily: "Inter_600SemiBold",
    color: colors.text,
    lineHeight: 30,
    letterSpacing: -0.35,
    marginBottom: 10,
    textAlign: "center",
  },
  subcopy: {
    alignSelf: "stretch",
    fontSize: 15,
    lineHeight: 22,
    color: colors.textMuted,
    marginBottom: 22,
    textAlign: "center",
  },
  featureList: {
    alignSelf: "stretch",
    width: "100%",
    gap: 14,
    marginBottom: 28,
  },
  featureRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    width: "100%",
  },
  bullet: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
    marginTop: 6,
  },
  featureText: {
    flex: 1,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textMuted,
    fontFamily: "Inter_400Regular",
    textAlign: "left",
  },
  actions: {
    gap: 12,
    width: "100%",
    alignSelf: "stretch",
  },
  primaryWrap: {
    borderRadius: radii.md,
    overflow: "hidden",
    ...shadow,
  },
  primaryGrad: {
    height: 56,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: {
    color: "#fff",
    fontFamily: "Inter_500Medium",
    fontSize: 16,
  },
  secondary: {
    height: 56,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  secondaryText: {
    color: colors.text,
    fontFamily: "Inter_500Medium",
    fontSize: 16,
  },
  btnPressed: {
    opacity: 0.92,
    transform: [{ scale: 0.97 }],
  },
});
