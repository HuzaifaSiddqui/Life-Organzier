import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radii, shadow } from "../../constants/theme";
import type { AuthStackParamList } from "../../navigation/AuthStack";

type Props = NativeStackScreenProps<AuthStackParamList, "Welcome">;

export function WelcomeScreen({ navigation }: Props) {
  return (
    <View style={styles.container}>
      <View style={styles.hero}>
        <View style={styles.logoMark}>
          <Text style={styles.logoMarkText}>LO</Text>
        </View>
        <Text style={styles.badge}>FYP-1 MVP</Text>
        <Text style={styles.logo}>Life Organizer</Text>
        <Text style={styles.tagline}>Plan smarter. Capture tasks by form, chat, or voice.</Text>
      </View>
      <View style={styles.features}>
        <Text style={styles.feature}>- Firebase-secured sign in</Text>
        <Text style={styles.feature}>- Smart parser for natural language tasks</Text>
        <Text style={styles.feature}>- Clean dashboard and task workflow</Text>
      </View>
      <View style={styles.actions}>
        <Pressable style={({ pressed }) => [styles.primary, pressed && styles.btnPressed]} onPress={() => navigation.navigate("Login")}>
          <Text style={styles.primaryText}>Log in</Text>
        </Pressable>
        <Pressable style={({ pressed }) => [styles.secondary, pressed && styles.btnPressed]} onPress={() => navigation.navigate("Signup")}>
          <Text style={styles.secondaryText}>Create account</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
  hero: {
    borderRadius: radii.lg,
    padding: 20,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow,
  },
  logoMark: {
    height: 56,
    width: 56,
    borderRadius: 16,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
    ...shadow,
  },
  logoMarkText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 18,
    letterSpacing: 0.5,
  },
  badge: {
    alignSelf: "flex-start",
    marginBottom: 12,
    backgroundColor: colors.surfaceSoft,
    color: colors.primaryDark,
    borderRadius: radii.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
    fontSize: 12,
    fontWeight: "700",
  },
  logo: {
    fontSize: 30,
    fontWeight: "700",
    color: colors.text,
  },
  tagline: {
    marginTop: 8,
    fontSize: 16,
    color: colors.textMuted,
    lineHeight: 22,
  },
  features: {
    marginTop: 16,
    borderRadius: radii.md,
    padding: 14,
    backgroundColor: "#eef2ff",
    borderWidth: 1,
    borderColor: "#d5dcff",
  },
  feature: {
    color: "#3730a3",
    fontSize: 13,
    fontWeight: "500",
    marginBottom: 6,
  },
  actions: {
    marginTop: 32,
    gap: 12,
  },
  primary: {
    backgroundColor: colors.primary,
    paddingVertical: 14,
    borderRadius: radii.md,
    alignItems: "center",
    ...shadow,
  },
  primaryText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 16,
  },
  secondary: {
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 14,
    borderRadius: radii.md,
    alignItems: "center",
    backgroundColor: colors.surface,
  },
  secondaryText: {
    color: colors.text,
    fontWeight: "600",
    fontSize: 16,
  },
  btnPressed: {
    opacity: 0.92,
    transform: [{ scale: 0.985 }],
  },
});
