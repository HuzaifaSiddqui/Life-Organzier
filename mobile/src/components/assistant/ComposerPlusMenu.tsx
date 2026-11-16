import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, { runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated";
import { useLocale } from "../../i18n/LocaleProvider";
import type { StringKey } from "../../i18n/strings";
import { useTheme } from "../../theme/ThemeProvider";
import { elevation } from "../../theme/tokens";
import { Icon, type IconName } from "../icons/Icon";
import { Text } from "../ui";

export type PlusMenuItem = { key: string; icon: IconName; label: StringKey; onPress: () => void };

/** Space between the "+" and the menu above it. */
const GAP = 8;

/**
 * The "+" next to the assistant's message box. A tap turns the "+" into a "×" (a 45° turn) and opens a small menu
 * just above it; "×", a choice, Back, or a tap anywhere else closes it and the "×" turns back into "+". Only
 * "Upload a file" for now; more choices go in `items`. The menu is shown in a transparent overlay so taps reach it on
 * Android too (a menu drawn outside its parent can't be tapped there). Reduce motion: it switches without moving.
 */
export function ComposerPlusMenu({ items, disabled }: { items: PlusMenuItem[]; disabled?: boolean }) {
  const { t } = useLocale();
  const { colors, spacing, radii, scheme, motion } = useTheme();
  const reduce = useReducedMotion();
  const { height } = useWindowDimensions();
  const buttonRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  /** The overlay stays up until the closing animation has played. */
  const [shown, setShown] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const progress = useSharedValue(0);

  const animateTo = useCallback(
    (to: 0 | 1) => {
      if (reduce) {
        progress.value = to;
        if (!to) setShown(false);
        return;
      }
      progress.value = withTiming(to, { duration: motion.duration.base }, (finished) => {
        if (finished && !to) runOnJS(setShown)(false);
      });
    },
    [reduce, progress, motion.duration.base],
  );

  const openMenu = () => {
    buttonRef.current?.measureInWindow((x, y) => {
      setAnchor({ x, y });
      setOpen(true);
      setShown(true);
      animateTo(1);
    });
  };

  const close = useCallback(() => {
    setOpen(false);
    animateTo(0);
  }, [animateTo]);

  useEffect(() => {
    if (disabled && open) close();
  }, [disabled, open, close]);

  const choose = (item: PlusMenuItem) => {
    close();
    item.onPress();
  };

  const iconStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${progress.value * 45}deg` }] }));
  const menuStyle = useAnimatedStyle(() => ({ opacity: progress.value, transform: [{ translateY: (1 - progress.value) * 8 }, { scale: 0.96 + progress.value * 0.04 }] }));

  return (
    <>
      <View ref={buttonRef} collapsable={false}>
        <Pressable
          onPress={open ? close : openMenu}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={t(open ? "chatPlus.close" : "chatPlus.open")}
          accessibilityState={{ expanded: open, disabled }}
          style={[styles.button, { borderColor: open ? colors.text : colors.hairline, backgroundColor: open ? colors.text : "transparent" }, disabled && { opacity: 0.5 }]}
        >
          <Animated.View style={iconStyle}>
            <Icon name="plus" size={20} color={open ? colors.canvas : colors.text} />
          </Animated.View>
        </Pressable>
      </View>
      <Modal visible={shown} transparent animationType="none" onRequestClose={close} statusBarTranslucent>
        {/* A tap anywhere outside the menu (also on the "×", which stays visible underneath) closes it. */}
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityRole="button" accessibilityLabel={t("chatPlus.close")} />
        {anchor ? (
          <Animated.View
            style={[styles.menu, elevation(2, scheme), { backgroundColor: colors.surface, borderRadius: radii.md, paddingVertical: spacing.xs, left: anchor.x, bottom: height - anchor.y + GAP }, menuStyle]}
            accessibilityRole="menu"
          >
            {items.map((item) => (
              <Pressable
                key={item.key}
                onPress={() => choose(item)}
                accessibilityRole="menuitem"
                style={({ pressed }) => [styles.item, { gap: spacing.md, paddingHorizontal: spacing.lg }, pressed && { backgroundColor: colors.accentSoft }]}
              >
                <Icon name={item.icon} size={20} color={colors.text} />
                <Text variant="body">{t(item.label)}</Text>
              </Pressable>
            ))}
          </Animated.View>
        ) : null}
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  button: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  menu: { position: "absolute", minWidth: 200 },
  item: { flexDirection: "row", alignItems: "center", minHeight: 48 },
});
