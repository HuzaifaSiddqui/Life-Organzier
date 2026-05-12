import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { LinearGradient } from "expo-linear-gradient";
import { signOut } from "firebase/auth";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import { BottomNav } from "../../components/BottomNav";
import { LogoMark } from "../../components/branding/LogoMark";
import { blue, colors, radii, shadow } from "../../constants/theme";
import { useAuth } from "../../context/AuthContext";
import { auth } from "../../lib/firebase";
import type { MainStackParamList } from "../../navigation/MainStack";

type Props = NativeStackScreenProps<MainStackParamList, "Profile">;

const futureModules = [
  "Calendar Integration",
  "Team Collaboration",
  "Analytics Dashboard",
  "API Access",
];

function initials(displayName: string | null | undefined, email: string | null | undefined): string {
  if (displayName?.trim()) {
    const parts = displayName.trim().split(/\s+/);
    const a = parts[0]?.[0] ?? "";
    const b = parts[1]?.[0] ?? "";
    return `${a}${b}`.toUpperCase() || a.toUpperCase();
  }
  const local = email?.split("@")[0]?.slice(0, 2) ?? "?";
  return local.toUpperCase();
}

function Chevron() {
  return (
    <Svg width={20} height={20} viewBox="0 0 20 20" fill="none">
      <Path
        d="M7 4L13 10L7 16"
        stroke="#64748B"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function ProfileScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { dbUser } = useAuth();
  const name = dbUser?.displayName ?? dbUser?.email?.split("@")[0] ?? "Account";
  const email = dbUser?.email ?? "";

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 100 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.hero}>
          <View style={styles.logoRow}>
            <View style={styles.logoRing}>
              <LogoMark size={44} />
            </View>
          </View>
          <Text style={styles.heroTitle}>Profile</Text>
          <Text style={styles.heroSub}>Manage your account</Text>
        </View>

        <View style={styles.accountCard}>
          <LinearGradient
            colors={["#1D99FF", "#47AFFF"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={styles.avatar}
          >
            <Text style={styles.avatarText}>{initials(dbUser?.displayName, dbUser?.email)}</Text>
          </LinearGradient>
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{name}</Text>
            <Text style={styles.email}>{email}</Text>
          </View>
        </View>

        <Text style={styles.sectionLabel}>Future Modules (FYP-2)</Text>
        <View style={styles.listCard}>
          {futureModules.map((item, i) => (
            <View key={item}>
              <Pressable
                style={({ pressed }) => [styles.listRow, pressed && { opacity: 0.85 }]}
                onPress={() =>
                  navigation.navigate("FuturePreview", {
                    title: item,
                  })
                }
              >
                <Text style={styles.listRowText}>{item}</Text>
                <Chevron />
              </Pressable>
              {i < futureModules.length - 1 ? <View style={styles.listSep} /> : null}
            </View>
          ))}
        </View>

        <Pressable
          style={({ pressed }) => [styles.logout, pressed && { opacity: 0.92 }]}
          onPress={() => {
            void signOut(auth);
          }}
        >
          <Text style={styles.logoutText}>Log out</Text>
        </Pressable>
      </ScrollView>

      <View style={[styles.navDock, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <BottomNav active="Profile" onChange={(tab) => navigation.navigate(tab)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 24,
  },
  navDock: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
  hero: {
    borderRadius: radii.xl,
    padding: 24,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    ...shadow,
  },
  logoRow: {
    alignItems: "center",
    marginBottom: 16,
  },
  /** Centers the mark in a fixed circle so it cannot sit high under the status bar / notch. */
  logoRing: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 2,
    borderColor: blue[200],
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  heroTitle: {
    fontSize: 22,
    fontWeight: "600",
    textAlign: "center",
    color: colors.text,
    marginBottom: 4,
  },
  heroSub: {
    textAlign: "center",
    color: colors.textMuted,
    fontSize: 15,
  },
  accountCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    backgroundColor: colors.surface,
    borderRadius: radii.xl,
    padding: 24,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 20,
  },
  name: {
    fontWeight: "600",
    fontSize: 17,
    color: colors.text,
  },
  email: {
    color: colors.textMuted,
    fontSize: 14,
    marginTop: 4,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "500",
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  listCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
    ...shadow,
  },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 24,
    paddingVertical: 16,
  },
  listRowText: {
    fontWeight: "500",
    fontSize: 16,
    color: colors.text,
  },
  listSep: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: 24,
    marginRight: 24,
  },
  logout: {
    height: 56,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#FECACA",
    backgroundColor: "#FEF2F2",
    marginBottom: 8,
  },
  logoutText: {
    color: "#DC2626",
    fontWeight: "600",
    fontSize: 16,
  },
});
