import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useState } from "react";
import { Keyboard, Platform, Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocale } from "../i18n/LocaleProvider";
import type { StringKey } from "../i18n/strings";
import { hapticTap } from "../services/haptics";
import { useTheme } from "../theme/ThemeProvider";
import { tabBar, withAlpha } from "../theme/tokens";
import { useLayout } from "../theme/useLayout";
import { PulseRings, useHoldToTalk, VoiceBubble } from "./assistant/HoldToTalk";
import { Icon, type IconName } from "./icons/Icon";
import { PressableScale, Text } from "./primitives";

/** UI v3 tabs (docs/design.md "Navigation"): two each side of the assistant button. */
export const TAB_META: Record<string, { icon: IconName; label: StringKey }> = {
  Dashboard: { icon: "today", label: "nav.today" },
  Plan: { icon: "plan", label: "nav.plan" },
  TaskList: { icon: "tasks", label: "nav.tasks" },
  Profile: { icon: "user", label: "nav.me" },
};

/**
 * The floating tab bar: a pill slides to the active tab (spring), the assistant sits raised in the centre (tap: chat,
 * hold: talk). Hidden while the keyboard is up and on wide windows (the Sidebar replaces it there).
 */
export function TabBar({ state, navigation, onAssistant }: BottomTabBarProps & { onAssistant: (voice: boolean) => void }) {
  const { colors, elevation, motion, radii } = useTheme();
  const { t } = useLocale();
  const insets = useSafeAreaInsets();
  const { isWide } = useLayout();
  const reduce = useReducedMotion();
  const [slotW, setSlotW] = useState(0);
  const [keyboard, setKeyboard] = useState(false);
  const x = useSharedValue(0);
  const shown = useSharedValue(1);

  useEffect(() => {
    const up = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => setKeyboard(true));
    const down = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setKeyboard(false));
    return () => {
      up.remove();
      down.remove();
    };
  }, []);

  // Slots: [tab0, tab1, centre, tab2, tab3]; the centre slot belongs to the assistant.
  const slotOf = (i: number) => (i < 2 ? i : i + 1);
  useEffect(() => {
    if (!slotW) return;
    const to = slotOf(state.index) * slotW;
    x.value = reduce ? to : withSpring(to, motion.spring.snappy);
  }, [state.index, slotW, reduce, motion.spring.snappy, x]);
  useEffect(() => {
    shown.value = reduce ? (keyboard ? 0 : 1) : withTiming(keyboard ? 0 : 1, { duration: motion.duration.fast });
  }, [keyboard, reduce, motion.duration.fast, shown]);

  const pill = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  // Hold-to-talk: the button grows while it listens.
  const talk = useHoldToTalk(() => onAssistant(false));
  const listening = talk.phase === "listening";
  const grow = useSharedValue(1);
  useEffect(() => {
    grow.value = reduce ? 1 : withSpring(listening ? 1.22 : 1, motion.spring.snappy);
  }, [listening, reduce, grow, motion.spring.snappy]);
  const growStyle = useAnimatedStyle(() => ({ transform: [{ scale: grow.value }] }));
  const dock = useAnimatedStyle(() => ({ opacity: shown.value, transform: [{ translateY: (1 - shown.value) * 40 }] }));

  if (isWide) return null;
  const onLayout = (e: LayoutChangeEvent) => setSlotW(e.nativeEvent.layout.width / 5);

  const tab = (route: (typeof state.routes)[number], i: number) => {
    const meta = TAB_META[route.name];
    if (!meta) return null;
    const active = state.index === i;
    const color = active ? colors.accentStrong : colors.textTertiary;
    const label = t(meta.label);
    return (
      <Pressable
        key={route.key}
        onPress={() => {
          const e = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
          if (!active && !e.defaultPrevented) {
            hapticTap();
            // Move the pill now, not after the next screen has rendered (a heavy first render would hold it back).
            if (slotW) x.value = reduce ? slotOf(i) * slotW : withSpring(slotOf(i) * slotW, motion.spring.snappy);
            navigation.navigate(route.name);
          }
        }}
        onLongPress={() => navigation.emit({ type: "tabLongPress", target: route.key })}
        accessibilityRole="tab"
        accessibilityState={{ selected: active }}
        accessibilityLabel={label}
        style={styles.slot}
      >
        <Icon name={meta.icon} size={22} color={color} strokeWidth={active ? 2.1 : 1.7} />
        <Text variant="label" maxFontSizeMultiplier={1.15} numberOfLines={1} style={{ color, fontSize: 11 }}>
          {label}
        </Text>
      </Pressable>
    );
  };

  return (
    <Animated.View pointerEvents={keyboard ? "none" : "box-none"} style={[styles.outer, { paddingBottom: Math.max(insets.bottom, 8), paddingHorizontal: tabBar.margin }, dock]}>
      {/* Content scrolling under the bar fades out instead of showing through around it. */}
      <LinearGradient pointerEvents="none" colors={[withAlpha(colors.canvas, 0), colors.canvas]} locations={[0, 0.55]} style={[styles.fade, { height: tabBar.height + Math.max(insets.bottom, 8) + 32 }]} />
      <View onLayout={onLayout} style={[styles.bar, elevation(2), { borderRadius: radii.xl, height: tabBar.height }]}>
        {slotW ? <Animated.View style={[styles.pill, { width: slotW - 12, backgroundColor: colors.accentSoft, borderRadius: radii.lg }, pill]} /> : null}
        {state.routes.slice(0, 2).map((r, i) => tab(r, i))}
        <View style={styles.slot} />
        {state.routes.slice(2).map((r, i) => tab(r, i + 2))}
      </View>
      <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, styles.centerWrap, { bottom: Math.max(insets.bottom, 8) }]}>
        <Animated.View style={[{ width: tabBar.center, height: tabBar.center }, growStyle]}>
          <PulseRings active={listening} size={tabBar.center} />
          <PressableScale
            onPress={() => {
              hapticTap();
              onAssistant(false);
            }}
            delayLongPress={220}
            onLongPress={() => void talk.begin()}
            onPressOut={() => talk.end()}
            accessibilityRole="button"
            accessibilityLabel={t("nav.assistant")}
            accessibilityHint={t("nav.assistantHint")}
            accessibilityState={{ busy: listening }}
            style={[styles.center, elevation(2), { width: tabBar.center, height: tabBar.center, borderRadius: tabBar.center / 2, borderColor: colors.surface }]}
          >
            <LinearGradient colors={listening ? [colors.danger.fg, colors.brand] : [colors.brand, colors.accent]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[StyleSheet.absoluteFill, { borderRadius: tabBar.center / 2 }]} />
            <Icon name={listening ? "mic" : "sparkle"} size={26} color={colors.onBrand} strokeWidth={2} />
          </PressableScale>
        </Animated.View>
      </View>
      <VoiceBubble
        phase={talk.phase}
        heard={talk.heard}
        reply={talk.reply}
        bottom={tabBar.height + Math.max(insets.bottom, 8) + 44}
        onClose={talk.dismiss}
        onOpenChat={() => {
          talk.dismiss();
          onAssistant(false);
        }}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  outer: { position: "absolute", left: 0, right: 0, bottom: 0 },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0 },
  bar: { flexDirection: "row", alignItems: "center", overflow: "visible" },
  slot: { flex: 1, height: "100%", alignItems: "center", justifyContent: "center", gap: 2 },
  pill: { position: "absolute", left: 6, top: 8, bottom: 8 },
  centerWrap: { alignItems: "center", justifyContent: "flex-start", top: -tabBar.center / 2 + 6 },
  center: { alignItems: "center", justifyContent: "center", borderWidth: 3, overflow: "hidden" },
});
