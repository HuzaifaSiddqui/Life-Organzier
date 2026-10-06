import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, palette, radii, shadowNav } from "../constants/theme";

export type Tab = "Dashboard" | "Assistant" | "TaskList" | "Insights" | "Profile";

type Props = {
  active: Tab;
  onChange: (tab: Tab) => void;
};

const tabs: { key: Tab; icon: string; label: string }[] = [
  { key: "Dashboard", icon: "🏠", label: "Home" },
  { key: "TaskList", icon: "✓", label: "Tasks" },
  { key: "Assistant", icon: "✨", label: "Assistant" },
  { key: "Insights", icon: "📊", label: "Insights" },
  { key: "Profile", icon: "👤", label: "Me" },
];

export function BottomNav({ active, onChange }: Props) {
  return (
    <View style={styles.outer}>
      <View style={styles.pill}>
        {tabs.map((tab) => {
          const isActive = tab.key === active;
          const isAssistant = tab.key === "Assistant";
          return (
            <Pressable
              key={tab.key}
              onPress={() => onChange(tab.key)}
              style={({ pressed }) => [styles.tab, isActive && styles.tabActive, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={`Go to ${tab.label}`}
            >
              <View style={[isAssistant && styles.assistantBubble, isAssistant && isActive && { backgroundColor: palette.aiDark }]}>
                <Text style={[styles.emoji, isAssistant && { fontSize: 18 }]}>{tab.icon}</Text>
              </View>
              <Text style={[styles.tabText, isActive && styles.tabTextActive, isAssistant && { color: palette.ai }]}>{tab.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: { paddingHorizontal: 12 },
  pill: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 6,
    ...shadowNav,
  },
  tab: { flex: 1, alignItems: "center", gap: 2, paddingVertical: 6, borderRadius: radii.pill },
  tabActive: { backgroundColor: "#EEF7FF" },
  assistantBubble: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: palette.ai,
    alignItems: "center",
    justifyContent: "center",
    marginTop: -2,
  },
  emoji: { fontSize: 18, lineHeight: 22 },
  tabText: { color: colors.textMuted, fontWeight: "600", fontSize: 11 },
  tabTextActive: { color: "#0065C3" },
  pressed: { opacity: 0.92, transform: [{ scale: 0.98 }] },
});
