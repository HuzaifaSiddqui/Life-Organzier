import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radii, shadowNav } from "../constants/theme";

type Tab = "Dashboard" | "TaskList" | "Profile";

type Props = {
  active: Tab;
  onChange: (tab: Tab) => void;
};

const tabs: { key: Tab; icon: string; label: string }[] = [
  { key: "Dashboard", icon: "🏠", label: "Dashboard" },
  { key: "TaskList", icon: "✓", label: "Tasks" },
  { key: "Profile", icon: "👤", label: "Profile" },
];

export function BottomNav({ active, onChange }: Props) {
  return (
    <View style={styles.outer}>
      <View style={styles.pill}>
        {tabs.map((tab) => {
          const isActive = tab.key === active;
          return (
            <Pressable
              key={tab.key}
              onPress={() => onChange(tab.key)}
              style={({ pressed }) => [
                styles.tab,
                isActive && styles.tabActive,
                pressed && styles.pressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={`Go to ${tab.label}`}
            >
              <Text style={styles.emoji}>{tab.icon}</Text>
              <Text style={[styles.tabText, isActive && styles.tabTextActive]}>{tab.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    paddingHorizontal: 16,
  },
  pill: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 6,
    ...shadowNav,
  },
  tab: {
    flex: 1,
    alignItems: "center",
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radii.pill,
  },
  tabActive: {
    backgroundColor: "#EEF7FF",
  },
  emoji: {
    fontSize: 20,
    lineHeight: 24,
  },
  tabText: {
    color: colors.textMuted,
    fontWeight: "600",
    fontSize: 12,
  },
  tabTextActive: {
    color: "#0065C3",
  },
  pressed: {
    opacity: 0.92,
    transform: [{ scale: 0.98 }],
  },
});
