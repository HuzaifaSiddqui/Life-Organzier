import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme/ThemeProvider";
import { Icon } from "./icons/Icon";
import { Text } from "./primitives";

type Props = {
  title: string;
  onBack?: () => void;
  right?: ReactNode;
};

export function ScreenHeader({ title, onBack, right }: Props) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  return (
    <View style={[styles.bar, { paddingTop: Math.max(insets.top, 12), backgroundColor: colors.canvas }]}>
      <View style={styles.side}>
        {onBack ? (
          <Pressable onPress={onBack} hitSlop={12} accessibilityRole="button" accessibilityLabel="Go back" style={styles.back}>
            <Icon name="back" size={24} color={colors.text} />
          </Pressable>
        ) : null}
      </View>
      <Text variant="headline" numberOfLines={1} ellipsizeMode="tail" center style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      <View style={[styles.side, styles.sideRight]}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingBottom: 10 },
  side: { minWidth: 48, justifyContent: "center" },
  sideRight: { alignItems: "flex-end" },
  back: { width: 40, height: 40, justifyContent: "center" },
  title: { flex: 1 },
});
