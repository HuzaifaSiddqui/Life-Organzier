import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { signOut } from "firebase/auth";
import { colors, radii, shadow } from "../../constants/theme";
import { useAuth } from "../../context/AuthContext";
import { auth } from "../../lib/firebase";
import type { MainStackParamList } from "../../navigation/MainStack";

type Props = NativeStackScreenProps<MainStackParamList, "Profile">;

const futureLinks: { title: string; label: string }[] = [
  { title: "Analytics", label: "Analytics preview" },
  { title: "Mood tracking", label: "Mood tracking" },
  { title: "Document upload", label: "Document upload" },
  { title: "Routine management", label: "Routine management" },
  { title: "Smart scheduling", label: "Smart scheduling" },
];

export function ProfileScreen({ navigation }: Props) {
  const { dbUser } = useAuth();

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.hero}>
        <Text style={styles.heroTitle}>Profile</Text>
        <Text style={styles.heroSub}>Manage your account and explore FYP-2 previews.</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Account</Text>
        <Text style={styles.meta}>{dbUser?.email}</Text>
        {dbUser?.displayName ? <Text style={styles.meta}>{dbUser.displayName}</Text> : null}
      </View>

      <Text style={styles.section}>Future modules (FYP-2)</Text>
      {futureLinks.map((item) => (
        <Pressable
          key={item.title}
          style={styles.linkRow}
          onPress={() => navigation.navigate("FuturePreview", { title: item.title })}
        >
          <Text style={styles.linkText}>{item.label}</Text>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
      ))}

      <Pressable
        style={styles.logout}
        onPress={() => {
          void signOut(auth);
        }}
      >
        <Text style={styles.logoutText}>Log out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    backgroundColor: colors.bg,
    paddingBottom: 40,
    gap: 10,
  },
  hero: {
    borderRadius: radii.lg,
    padding: 16,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow,
  },
  heroTitle: {
    fontSize: 24,
    fontWeight: "700",
    color: colors.text,
  },
  heroSub: {
    marginTop: 4,
    color: colors.textMuted,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
    marginBottom: 6,
  },
  meta: {
    color: colors.textMuted,
    fontSize: 15,
  },
  section: {
    marginTop: 12,
    fontSize: 14,
    fontWeight: "600",
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  linkRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow,
  },
  linkText: {
    fontSize: 16,
    color: colors.text,
    fontWeight: "500",
  },
  chevron: {
    fontSize: 22,
    color: "#94a3b8",
  },
  logout: {
    marginTop: 20,
    borderWidth: 1,
    borderColor: "#fca5a5",
    paddingVertical: 12,
    borderRadius: radii.md,
    alignItems: "center",
    backgroundColor: "#fef2f2",
  },
  logoutText: {
    color: "#b91c1c",
    fontWeight: "600",
  },
});
