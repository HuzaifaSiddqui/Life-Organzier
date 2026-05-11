import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { LinearGradient } from "expo-linear-gradient";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LogoFull } from "../../components/branding/LogoFull";
import { colors, radii, shadow } from "../../constants/theme";
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
  return (
    <SafeAreaView style={styles.safe} edges={["left", "right"]}>
      <View style={styles.inner}>
        {/* Full-area layer: features dead-center (vertical + horizontal) */}
        <View style={styles.featuresPlane} pointerEvents="none">
          <View style={styles.features}>
            {features.map((line) => (
              <Text key={line} style={styles.featureText}>
                {"\u2022"} {line}
              </Text>
            ))}
          </View>
        </View>

        {/* Overlay: header top + actions bottom; middle is touch-transparent */}
        <View style={styles.overlay} pointerEvents="box-none">
          <View style={styles.headerBlock} pointerEvents="auto">
            <View style={styles.logoWrap}>
              <LogoFull width={200} height={75} />
            </View>
            <Text style={styles.headline}>Your AI-Powered Life Assistant</Text>
            <Text style={styles.subcopy}>Capture tasks naturally, organize effortlessly</Text>
          </View>

          <View style={styles.overlaySpacer} pointerEvents="none" />

          <View style={styles.actions} pointerEvents="auto">
            <Pressable
              style={({ pressed }) => [styles.primaryWrap, pressed && styles.btnPressed]}
              onPress={() => navigation.navigate("Login")}
            >
              <LinearGradient
                colors={["#1D99FF", "#47AFFF"]}
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
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    width: "100%",
    backgroundColor: colors.surface,
  },
  inner: {
    flex: 1,
    width: "100%",
  },
  featuresPlane: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
    zIndex: 0,
  },
  features: {
    gap: 26,
    width: "100%",
    maxWidth: 340,
    alignItems: "center",
  },
  featureText: {
    width: "100%",
    color: colors.textMuted,
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
    fontWeight: 400,
  },
  overlay: {
    flex: 1,
    paddingHorizontal: 24,
    zIndex: 1,
  },
  overlaySpacer: {
    flex: 1,
  },
  headerBlock: {
    paddingTop: 8,
    alignItems: "center",
  },
  logoWrap: {
    alignItems: "center",
    marginBottom: 20,
  },
  headline: {
    fontSize: 28,
    fontWeight: "600",
    textAlign: "center",
    color: colors.text,
    lineHeight: 34,
    letterSpacing: -0.28,
    marginBottom: 12,
  },
  subcopy: {
    textAlign: "center",
    color: colors.textMuted,
    fontSize: 16,
    lineHeight: 24,
  },
  actions: {
    gap: 12,
    width: "100%",
    flexShrink: 0,
    paddingTop: 16,
    paddingBottom: 8,
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
    fontWeight: "600",
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
    fontWeight: "600",
    fontSize: 16,
  },
  btnPressed: {
    opacity: 0.92,
    transform: [{ scale: 0.97 }],
  },
});
