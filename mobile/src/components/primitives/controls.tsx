import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from "react-native-reanimated";
import { useTheme } from "../../theme/ThemeProvider";
import { radii, spacing, touchTarget } from "../../theme/tokens";
import { colorFor, Text, type TextColor } from "./Text";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export type PressableScaleProps = Omit<PressableProps, "style"> & {
  style?: StyleProp<ViewStyle>;
  pressedStyle?: StyleProp<ViewStyle>;
  /** Pass false for large list rows where scaling the whole row is distracting. */
  scale?: boolean;
};

/**
 * Pressable with spring scale-down, focus ring and disabled state. Base for every tappable element.
 * Animates transform only; falls back to no movement when the OS asks to reduce motion.
 */
export function PressableScale({ style, pressedStyle, scale = true, disabled, onPressIn, onPressOut, onFocus, onBlur, accessibilityState, ...rest }: PressableScaleProps) {
  const { colors, motion } = useTheme();
  const reduceMotion = useReducedMotion();
  const s = useSharedValue(1);
  const [pressed, setPressed] = useState(false);
  const [focused, setFocused] = useState(false);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  const animate = scale && !reduceMotion;
  return (
    <AnimatedPressable
      {...rest}
      disabled={disabled}
      accessibilityState={{ disabled: !!disabled, ...accessibilityState }}
      onPressIn={(e) => {
        setPressed(true);
        if (animate) s.value = withSpring(motion.pressScale, motion.spring.press);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        setPressed(false);
        if (animate) s.value = withSpring(1, motion.spring.press);
        onPressOut?.(e);
      }}
      onFocus={(e) => {
        setFocused(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        onBlur?.(e);
      }}
      style={[style, pressed && pressedStyle, focused && { outlineWidth: 2, outlineColor: colors.accentFocus, outlineOffset: 2 }, disabled && styles.disabled, animated]}
    />
  );
}

export type ButtonKind = "primary" | "secondary" | "tonal" | "ghost" | "danger";

export function Button({
  title,
  onPress,
  kind = "primary",
  size = "md",
  icon,
  loading,
  disabled,
  style,
  accessibilityLabel,
}: {
  title: string;
  onPress: () => void;
  kind?: ButtonKind;
  size?: "md" | "sm";
  icon?: ReactNode;
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const { colors } = useTheme();
  const look: Record<ButtonKind, { bg: string; fg: TextColor; pressed: string; border?: string }> = {
    primary: { bg: colors.accent, fg: "onAccent", pressed: colors.accent },
    secondary: { bg: "transparent", fg: "primary", pressed: colors.accentSoft, border: colors.hairline },
    tonal: { bg: colors.accentSoft, fg: "accent", pressed: colors.accentPressed },
    ghost: { bg: "transparent", fg: "accent", pressed: colors.accentSoft },
    danger: { bg: colors.danger.bg, fg: "danger", pressed: colors.danger.bg },
  };
  const l = look[kind];
  const sm = size === "sm";
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ busy: !!loading }}
      hitSlop={sm ? (touchTarget - 40) / 2 : undefined}
      style={[styles.button, sm && styles.buttonSm, { backgroundColor: l.bg }, l.border ? { borderWidth: 1, borderColor: l.border } : null, style]}
      pressedStyle={kind === "primary" || kind === "danger" ? styles.pressedSolid : { backgroundColor: l.pressed }}
    >
      {loading ? (
        <ActivityIndicator color={colorFor(colors, l.fg)} />
      ) : (
        <>
          {icon}
          <Text variant={sm ? "label" : "bodyStrong"} color={l.fg} numberOfLines={1}>
            {title}
          </Text>
        </>
      )}
    </PressableScale>
  );
}

/** Icon-only button. Visual size 40, touch target 48 via hitSlop. Label is mandatory for screen readers. */
export function IconButton({
  icon,
  onPress,
  accessibilityLabel,
  variant = "plain",
  selected,
  disabled,
  style,
}: {
  icon: ReactNode;
  onPress: () => void;
  accessibilityLabel: string;
  variant?: "plain" | "tonal";
  selected?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: !!selected }}
      hitSlop={(touchTarget - 40) / 2}
      style={[styles.icon, (variant === "tonal" || selected) && { backgroundColor: colors.accentSoft }, style]}
      pressedStyle={{ backgroundColor: colors.accentPressed }}
    >
      {icon}
    </PressableScale>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  onLongPress,
  tone = "accent",
  small,
  leading,
  accessibilityLabel,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  tone?: "accent" | "danger";
  small?: boolean;
  /** e.g. a priority/category dot — pair colour with the label, never colour alone. */
  leading?: ReactNode;
  accessibilityLabel?: string;
}) {
  const { colors } = useTheme();
  const fg = tone === "danger" ? colors.danger.fg : colors.accent;
  const soft = tone === "danger" ? colors.danger.bg : colors.accentSoft;
  const interactive = !!onPress || !!onLongPress;
  const height = small ? 28 : 32;
  return (
    <PressableScale
      onPress={onPress}
      onLongPress={onLongPress}
      scale={interactive}
      accessibilityRole={interactive ? "button" : "text"}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: !!selected }}
      hitSlop={{ top: (touchTarget - height) / 2, bottom: (touchTarget - height) / 2 }}
      style={[styles.chip, { height, borderColor: selected ? fg : colors.hairline }, small && styles.chipSmall, selected && { backgroundColor: soft }]}
      pressedStyle={interactive ? { backgroundColor: colors.accentPressed } : undefined}
    >
      {leading}
      <Text variant={small ? "label" : "callout"} color={selected ? (tone === "danger" ? "danger" : "accent") : "primary"} numberOfLines={1} style={styles.chipText}>
        {label}
      </Text>
    </PressableScale>
  );
}

/** Small colour dot for priority/category. Always render next to a text label. */
export function Dot({ color, size = 8 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

const styles = StyleSheet.create({
  disabled: { opacity: 0.45 },
  button: {
    minHeight: touchTarget,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  buttonSm: { minHeight: 40, paddingHorizontal: spacing.md, borderRadius: radii.sm },
  pressedSolid: { opacity: 0.88 },
  icon: { width: 40, height: 40, borderRadius: radii.pill, alignItems: "center", justifyContent: "center" },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    maxWidth: 260,
  },
  chipSmall: { paddingHorizontal: 10 },
  chipText: { flexShrink: 1 },
});
