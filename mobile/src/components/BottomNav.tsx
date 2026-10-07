import { Pressable, StyleSheet, View } from "react-native";
import { useTheme } from "../theme/ThemeProvider";
import { Icon, type IconName } from "./icons/Icon";
import { Text } from "./primitives";

export type Tab = "Dashboard" | "Assistant" | "TaskList" | "Insights" | "Profile";

type Props = {
  active: Tab;
  onChange: (tab: Tab) => void;
};

const tabs: { key: Tab; icon: IconName; label: string }[] = [
  { key: "Dashboard", icon: "home", label: "Home" },
  { key: "TaskList", icon: "tasks", label: "Tasks" },
  { key: "Assistant", icon: "assistant", label: "Assistant" },
  { key: "Insights", icon: "insights", label: "Insights" },
  { key: "Profile", icon: "user", label: "Me" },
];

export function BottomNav({ active, onChange }: Props) {
  const { colors, elevation } = useTheme();
  return (
    <View style={styles.outer}>
      <View style={[styles.bar, elevation(2), { borderRadius: 20 }]}>
        {tabs.map((tab) => {
          const isActive = tab.key === active;
          const color = isActive ? colors.text : colors.textTertiary;
          return (
            <Pressable
              key={tab.key}
              onPress={() => onChange(tab.key)}
              style={({ pressed }) => [styles.tab, pressed && { opacity: 0.6 }]}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
              accessibilityLabel={tab.label}
            >
              <Icon name={tab.icon} size={22} color={color} strokeWidth={isActive ? 2.1 : 1.7} />
              <Text variant="label" style={{ color, fontSize: 11 }}>
                {tab.label}
              </Text>
              <View style={[styles.indicator, { backgroundColor: isActive ? colors.text : "transparent" }]} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: { paddingHorizontal: 16 },
  bar: { flexDirection: "row", paddingTop: 10, paddingBottom: 6 },
  tab: { flex: 1, alignItems: "center", gap: 3, minHeight: 48 },
  indicator: { width: 4, height: 4, borderRadius: 2, marginTop: 1 },
});
