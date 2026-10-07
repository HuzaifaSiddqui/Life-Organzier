import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { signOut } from "firebase/auth";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomNav } from "../../components/BottomNav";
import { Icon, type IconName } from "../../components/icons/Icon";
import { Card, SyncBadge, Text } from "../../components/ui";
import { useAuth } from "../../context/AuthContext";
import { usePreferences } from "../../context/PreferencesContext";
import { auth } from "../../lib/firebase";
import type { MainStackParamList } from "../../navigation/MainStack";
import { clearAllReminders } from "../../services/reminders";
import { useTheme } from "../../theme/ThemeProvider";

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
  const { colors, spacing } = useTheme();
  const { dbUser } = useAuth();
  const { settings, isPro } = usePreferences();
  const name = dbUser?.displayName ?? dbUser?.email?.split("@")[0] ?? "Account";

  const groups: Array<{ title: string; items: Array<{ icon: IconName; title: string; subtitle: string; go: () => void }> }> = [
    {
      title: "Your data",
      items: [
        { icon: "memory", title: "What the assistant knows", subtitle: "Memories and learned patterns", go: () => navigation.navigate("Memory") },
        { icon: "repeat", title: "Routines", subtitle: "Recurring habits and classes", go: () => navigation.navigate("Routines") },
        { icon: "pulse", title: "Mood", subtitle: "Check-ins and history", go: () => navigation.navigate("Mood") },
        { icon: "doc", title: "Documents", subtitle: "Syllabi, timetables and notes", go: () => navigation.navigate("Documents") },
        { icon: "insights", title: "Insights", subtitle: "Productivity analytics", go: () => navigation.navigate("Insights") },
      ],
    },
    {
      title: "App",
      items: [{ icon: "settings", title: "Settings", subtitle: "Preferences, notifications and account", go: () => navigation.navigate("Settings") }],
    },
  ];

  const divider = <View style={[styles.divider, { backgroundColor: colors.hairline }]} />;

  return (
    <View style={[styles.root, { paddingTop: insets.top, backgroundColor: colors.canvas }]}>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 110, gap: spacing.xl }]} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <Text variant="title1" style={styles.flex}>
            Account
          </Text>
          <SyncBadge />
        </View>

        <Card style={styles.account}>
          <View style={[styles.avatar, { backgroundColor: colors.text }]}>
            <Text variant="headline" style={{ color: colors.canvas }}>
              {initials(dbUser?.displayName, dbUser?.email)}
            </Text>
          </View>
          <View style={styles.flex}>
            <Text variant="headline" numberOfLines={1}>
              {name}
            </Text>
            <Text variant="callout" color="secondary" numberOfLines={1}>
              {dbUser?.email}
            </Text>
            <Text variant="caption" color="tertiary" style={{ marginTop: 2 }}>
              {isPro ? "Pro plan" : "Free plan"}
              {settings?.currentContext ? ` · ${settings.currentContext}` : ""}
            </Text>
          </View>
        </Card>

        {groups.map((g) => (
          <View key={g.title}>
            <Text variant="label" color="tertiary" style={styles.sectionLabel} accessibilityRole="header">
              {g.title.toUpperCase()}
            </Text>
            <Card style={styles.listCard}>
              {g.items.map((item, i) => (
                <View key={item.title}>
                  {i > 0 ? divider : null}
                  <Pressable
                    onPress={item.go}
                    accessibilityRole="button"
                    accessibilityLabel={`${item.title}, ${item.subtitle}`}
                    style={({ pressed }) => [styles.item, pressed && { backgroundColor: colors.accentSoft }]}
                  >
                    <Icon name={item.icon} color={colors.textSecondary} />
                    <View style={styles.flex}>
                      <Text variant="body">{item.title}</Text>
                      <Text variant="caption" color="tertiary">
                        {item.subtitle}
                      </Text>
                    </View>
                    <Icon name="chevron" size={16} color={colors.textTertiary} />
                  </Pressable>
                </View>
              ))}
            </Card>
          </View>
        ))}

        <Card style={styles.listCard}>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              void clearAllReminders().finally(() => {
                void signOut(auth);
              });
            }}
            style={({ pressed }) => [styles.item, pressed && { backgroundColor: colors.danger.bg }]}
          >
            <Icon name="logout" color={colors.danger.fg} />
            <Text variant="body" color="danger" style={styles.flex}>
              Sign out
            </Text>
          </Pressable>
        </Card>
      </ScrollView>
      <View style={[styles.navDock, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <BottomNav active="Profile" onChange={(tab) => navigation.navigate(tab)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 16 },
  headerRow: { flexDirection: "row", alignItems: "center" },
  flex: { flex: 1 },
  account: { flexDirection: "row", alignItems: "center", gap: 14 },
  avatar: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center" },
  sectionLabel: { marginBottom: 8 },
  listCard: { padding: 0, overflow: "hidden" },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 50 },
  item: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 60, paddingHorizontal: 16, paddingVertical: 10 },
  navDock: { position: "absolute", left: 0, right: 0, bottom: 0 },
});
