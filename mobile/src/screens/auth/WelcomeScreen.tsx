import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { AuthStackParamList } from "../../navigation/AuthStack";

type Props = NativeStackScreenProps<AuthStackParamList, "Welcome">;

export function WelcomeScreen({ navigation }: Props) {
  return (
    <View style={styles.container}>
      <Text style={styles.logo}>Life Organizer</Text>
      <Text style={styles.tagline}>AI-powered personal productivity assistant</Text>
      <View style={styles.actions}>
        <Pressable style={styles.primary} onPress={() => navigation.navigate("Login")}>
          <Text style={styles.primaryText}>Log in</Text>
        </Pressable>
        <Pressable style={styles.secondary} onPress={() => navigation.navigate("Signup")}>
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
    backgroundColor: "#f7f8fb",
  },
  logo: {
    fontSize: 28,
    fontWeight: "700",
    color: "#0f172a",
    textAlign: "center",
  },
  tagline: {
    marginTop: 8,
    fontSize: 15,
    color: "#64748b",
    textAlign: "center",
  },
  actions: {
    marginTop: 32,
    gap: 12,
  },
  primary: {
    backgroundColor: "#2563eb",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  primaryText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 16,
  },
  secondary: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: "#fff",
  },
  secondaryText: {
    color: "#0f172a",
    fontWeight: "600",
    fontSize: 16,
  },
});
