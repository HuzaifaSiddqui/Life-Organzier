import { useEffect, useState, type ReactNode } from "react";
import { Keyboard, Modal, Platform, Pressable, StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedKeyboard, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocale } from "../../i18n/LocaleProvider";
import { useTheme } from "../../theme/ThemeProvider";
import { layout, radii, spacing } from "../../theme/tokens";
import { useLayout } from "../../theme/useLayout";
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
  titleLines = 1,
  subtitleLines = 2,
}: {
  title: string;
  subtitle?: string;
  /** Line limits (0 = wrap fully). Defaults keep rows compact; settings rows with a sentence can wrap. */
  titleLines?: number;
  subtitleLines?: number;
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
        <Text variant="body" numberOfLines={titleLines || undefined}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" color="secondary" numberOfLines={subtitleLines || undefined}>
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

/**
 * Keeps its content above the on-screen keyboard by padding the bottom with the keyboard's height.
 * Android 15+ draws edge-to-edge and no longer resizes the window, so nothing else moves inputs out of the way.
 * One wraps the whole app (RootNavigator). A Modal is a separate window and needs its own.
 */
export function KeyboardPad({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  // Web / desktop: no on-screen keyboard to avoid (and useAnimatedKeyboard isn't available there).
  if (Platform.OS === "web") return <View style={[styles.keyboardPad, style]}>{children}</View>;
  return <PhoneKeyboardPad style={style}>{children}</PhoneKeyboardPad>;
}

function PhoneKeyboardPad({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const animated = useAnimatedKeyboard(); // follows the keyboard frame by frame in the app window
  const [shown, setShown] = useState(0); // keyboard events also arrive while a Modal has the keyboard
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", (e) => setShown(e.endCoordinates.height));
    const hide = Keyboard.addListener("keyboardDidHide", () => setShown(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  const pad = useAnimatedStyle(() => ({ paddingBottom: Math.max(animated.height.value, shown) }), [shown]);
  return <Animated.View style={[styles.keyboardPad, style, pad]}>{children}</Animated.View>;
}

/**
 * Bottom sheet (elevation 2). Tapping the scrim or back closes it. Not for text entry: see LocationPickerSheet.
 * Wide windows (desktop) show the same content as a centred Dialog: a full-width sheet doesn't fit a desktop window.
 */
export function Sheet(props: { visible: boolean; onClose: () => void; title?: string; children: ReactNode }) {
  const { isWide } = useLayout();
  return isWide ? <Dialog {...props} /> : <BottomSheet {...props} />;
}

function BottomSheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title?: string; children: ReactNode }) {
  const { colors, elevation, motion } = useTheme();
  const { t } = useLocale();
  const insets = useSafeAreaInsets();
  // Slides up with a transform. Not a layout `entering` animation: when the content changes height while
  // that runs (an address loading), the sheet stays drawn away from where it is and taps miss its buttons.
  const offset = useSharedValue(0);
  useEffect(() => {
    if (!visible) return;
    offset.value = 320;
    offset.value = withSpring(0, motion.spring.gentle);
  }, [visible, offset, motion.spring.gentle]);
  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }] }));
  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      {/* Bottom-anchored flex child (not position: absolute) so the sheet re-measures when its content changes. */}
      <View style={styles.sheetRoot}>
        <Pressable style={[styles.scrim, { backgroundColor: colors.scrim }]} onPress={onClose} accessibilityRole="button" accessibilityLabel={t("common.close")} />
        <Animated.View
          accessibilityViewIsModal
          style={[styles.sheet, elevation(2), { paddingBottom: Math.max(insets.bottom, spacing.lg) + spacing.sm }, slide]}
        >
          <View style={[styles.handle, { backgroundColor: colors.hairline }]} />
          {title ? (
            <Text variant="title2" accessibilityRole="header">
              {title}
            </Text>
          ) : null}
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

/**
 * Centred dialog (elevation 2), at most `layout.dialogMax` wide. Used for confirmations on web / desktop (DialogHost)
 * and for sheets on wide windows. Tapping the scrim or Esc / back closes it.
 */
export function Dialog({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title?: string; children: ReactNode }) {
  const { colors, elevation } = useTheme();
  const { t } = useLocale();
  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.dialogRoot}>
        <Pressable style={[styles.scrim, { backgroundColor: colors.scrim }]} onPress={onClose} accessibilityRole="button" accessibilityLabel={t("common.close")} />
        <View accessibilityViewIsModal accessibilityRole="alert" style={[styles.dialog, elevation(2)]}>
          {title ? (
            <Text variant="title2" accessibilityRole="header">
              {title}
            </Text>
          ) : null}
          {children}
        </View>
      </View>
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
  keyboardPad: { flex: 1 },
  sheetRoot: { flex: 1, justifyContent: "flex-end" },
  sheet: {
    borderTopStartRadius: radii.lg,
    borderTopEndRadius: radii.lg,
    borderBottomWidth: 0,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    gap: spacing.md,
  },
  handle: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, marginBottom: spacing.sm },
  dialogRoot: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  dialog: { width: "100%", maxWidth: layout.dialogMax, borderRadius: radii.lg, padding: spacing.xl, gap: spacing.md },
});
