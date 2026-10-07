import { useEffect, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from "react-native";
import Animated, { SlideInDown, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocale } from "../../i18n/LocaleProvider";
import { useTheme } from "../../theme/ThemeProvider";
import { radii, spacing } from "../../theme/tokens";
import { PressableScale } from "./controls";
import { Text } from "./Text";

export type CardTone = "neutral" | "accent" | "success" | "warning" | "danger";

/**
 * Elevation-1 container. Use for one self-contained unit; never nest cards — inside a card,
 * separate content with spacing and type instead.
 */
export function Card({
  children,
  style,
  tone = "neutral",
  onPress,
  accessibilityLabel,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  tone?: CardTone;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const { colors, elevation } = useTheme();
  const toneStyle: ViewStyle | null =
    tone === "neutral" ? null : { backgroundColor: tone === "accent" ? colors.accentSoft : colors[tone].bg, borderColor: "transparent", elevation: 0, shadowOpacity: 0 };
  const base = [styles.card, elevation(1), toneStyle, style];
  if (!onPress) return <View style={base}>{children}</View>;
  return (
    <PressableScale onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel} style={base}>
      {children}
    </PressableScale>
  );
}

/** Single row: leading slot, title + optional subtitle, trailing slot. Min height 56. */
export function ListItem({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  accessibilityLabel,
}: {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const { colors } = useTheme();
  const content = (
    <>
      {leading}
      <View style={styles.listText}>
        <Text variant="body" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" color="secondary" numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
    </>
  );
  if (!onPress) return <View style={styles.listItem}>{content}</View>;
  return (
    <PressableScale
      scale={false}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (subtitle ? `${title}, ${subtitle}` : title)}
      style={styles.listItem}
      pressedStyle={{ backgroundColor: colors.accentSoft }}
    >
      {content}
    </PressableScale>
  );
}

/** Bottom sheet (elevation 2). Tapping the scrim or back closes it. */
export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title?: string; children: ReactNode }) {
  const { colors, elevation, motion } = useTheme();
  const { t } = useLocale();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <Pressable style={[styles.scrim, { backgroundColor: colors.scrim }]} onPress={onClose} accessibilityRole="button" accessibilityLabel={t("common.close")} />
      <Animated.View
        entering={SlideInDown.springify().damping(motion.spring.gentle.damping).stiffness(motion.spring.gentle.stiffness)}
        accessibilityViewIsModal
        style={[styles.sheet, elevation(2), { paddingBottom: Math.max(insets.bottom, spacing.lg) + spacing.sm }]}
      >
        <View style={[styles.handle, { backgroundColor: colors.hairline }]} />
        {title ? (
          <Text variant="title2" accessibilityRole="header">
            {title}
          </Text>
        ) : null}
        {children}
      </Animated.View>
    </Modal>
  );
}

/** Placeholder block. Compose skeletons that match the final layout; never use a bare spinner for content. */
export function Skeleton({ height = 16, width = "100%", radius = radii.sm, style }: { height?: number; width?: DimensionValue; radius?: number; style?: StyleProp<ViewStyle> }) {
  const { colors, motion } = useTheme();
  const reduceMotion = useReducedMotion();
  const o = useSharedValue(1);
  useEffect(() => {
    if (!reduceMotion) o.value = withRepeat(withTiming(0.5, { duration: motion.duration.pulse }), -1, true);
  }, [o, reduceMotion, motion.duration.pulse]);
  const animated = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[{ height, width, borderRadius: radius, backgroundColor: colors.skeleton }, animated, style]} />;
}

const styles = StyleSheet.create({
  card: { borderRadius: radii.md, padding: spacing.lg },
  listItem: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  listText: { flex: 1, gap: 2 },
  scrim: StyleSheet.absoluteFill,
  sheet: {
    position: "absolute",
    start: 0,
    end: 0,
    bottom: 0,
    borderTopStartRadius: radii.lg,
    borderTopEndRadius: radii.lg,
    borderBottomWidth: 0,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    gap: spacing.md,
  },
  handle: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, marginBottom: spacing.sm },
});
