import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { LinearGradient } from "expo-linear-gradient";
import { signOut } from "firebase/auth";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomNav } from "../../components/BottomNav";
import { Card, SyncBadge } from "../../components/ui";
import { colors, palette, radii } from "../../constants/theme";
import { useAuth } from "../../context/AuthContext";
import { usePreferences } from "../../context/PreferencesContext";
import { auth } from "../../lib/firebase";
import type { MainStackParamList } from "../../navigation/MainStack";
import { clearAllReminders } from "../../services/reminders";

type Props = NativeStackScreenProps<MainStackParamList, "Profile">;

function initials(displayName: string | null | undefined, email: string | null | undefined): string {
  if (displayName?.trim()) {
    const parts = displayName.trim().split(/\s+/);
    return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  }
  return (email?.split("@")[0]?.slice(0, 2) ?? "?").toUpperCase();
}

export function ProfileScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { dbUser } = useAuth();
  const { settings, isPro } = usePreferences();
  const name = dbUser?.displayName ?? dbUser?.email?.split("@")[0] ?? "Account";

  const items: Array<{ icon: string; title: string; subtitle: string; go: () => void }> = [
    { icon: "🧠", title: "What I know about you", subtitle: "Memories & learned patterns", go: () => navigation.navigate("Memory") },
    { icon: "🔁", title: "Routines", subtitle: "Recurring habits & classes", go: () => navigation.navigate("Routines") },
    { icon: "🙂", title: "Mood", subtitle: "Check-ins & history", go: () => navigation.navigate("Mood") },
    { icon: "📄", title: "Documents", subtitle: "Syllabi, timetables, notes", go: () => navigation.navigate("Documents") },
    { icon: "📊", title: "Insights", subtitle: "Productivity analytics", go: () => navigation.navigate("Insights") },
    { icon: "⚙️", title: "Settings", subtitle: "Preferences, notifications, account", go: () => navigation.navigate("Settings") },
  ];

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 110 }]}>
        <Card style={styles.account}>
          <LinearGradient colors={[palette.ai, "#47AFFF"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.avatar}>
            <Text style={styles.avatarText}>{initials(dbUser?.displayName, dbUser?.email)}</Text>
          </LinearGradient>
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{name}</Text>
            <Text style={styles.meta}>{dbUser?.email}</Text>
            <Text style={[styles.plan, isPro && { color: palette.ai }]}>{isPro ? "✨ Pro plan" : "Free plan"}{settings?.currentContext ? ` · 📍 ${settings.currentContext}` : ""}</Text>
          </View>
        </Card>
        <SyncBadge />
        {items.map((item) => (
          <Pressable key={item.title} onPress={item.go} style={({ pressed }) => [styles.item, pressed && { opacity: 0.85 }]}>
            <Text style={styles.icon}>{item.icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.itemTitle}>{item.title}</Text>
              <Text style={styles.meta}>{item.subtitle}</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ))}
        <Pressable
          style={styles.signOut}
          onPress={() => {
            void clearAllReminders().finally(() => {
              void signOut(auth);
            });
          }}
        >
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      </ScrollView>
      <View style={[styles.navDock, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <BottomNav active="Profile" onChange={(tab) => navigation.navigate(tab)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 10 },
  account: { flexDirection: "row", alignItems: "center", gap: 14, marginBottom: 6 },
  avatar: { width: 60, height: 60, borderRadius: 30, alignItems: "center", justifyContent: "center" },
  avatarText: { color: "#fff", fontSize: 22, fontWeight: "800" },
  name: { fontSize: 20, fontWeight: "800", color: colors.text },
  meta: { fontSize: 13, color: colors.textMuted },
  plan: { fontSize: 13, fontWeight: "700", color: colors.textMuted, marginTop: 2 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
  },
  icon: { fontSize: 22 },
  itemTitle: { fontSize: 16, fontWeight: "700", color: colors.text },
  chevron: { fontSize: 24, color: colors.textMuted },
  signOut: { marginTop: 10, alignItems: "center", padding: 14, borderRadius: radii.md, borderWidth: 1, borderColor: "#FECACA", backgroundColor: palette.dangerSoft },
  signOutText: { color: palette.danger, fontWeight: "800", fontSize: 16 },
  navDock: { position: "absolute", left: 0, right: 0, bottom: 0 },
});
