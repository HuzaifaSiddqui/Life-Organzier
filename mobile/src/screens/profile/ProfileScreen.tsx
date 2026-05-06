import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { signOut } from "firebase/auth";
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
    backgroundColor: "#f7f8fb",
    paddingBottom: 40,
    gap: 10,
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#0f172a",
    marginBottom: 6,
  },
  meta: {
    color: "#475569",
    fontSize: 15,
  },
  section: {
    marginTop: 12,
    fontSize: 14,
    fontWeight: "600",
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  linkRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  linkText: {
    fontSize: 16,
    color: "#0f172a",
    fontWeight: "500",
  },
  chevron: {
    fontSize: 22,
    color: "#94a3b8",
  },
  logout: {
    marginTop: 20,
    borderWidth: 1,
    borderColor: "#fecaca",
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
    backgroundColor: "#fef2f2",
  },
  logoutText: {
    color: "#b91c1c",
    fontWeight: "600",
  },
});
