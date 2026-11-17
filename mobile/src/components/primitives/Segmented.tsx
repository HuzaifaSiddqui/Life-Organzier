import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from "react-native-reanimated";
import { hapticTap } from "../../services/haptics";
import { useTheme } from "../../theme/ThemeProvider";
import { Text } from "./Text";

/**
 * UI v3 segmented control: a raised thumb slides (spring) to the chosen option. For 2–4 short, mutually exclusive views
 * (Day / Week / Month). Each option is a 40 dp tall tab with a 48 dp touch area.
 */
export function Segmented<T extends string>({ options, value, onChange, accessibilityLabel }: { options: Array<{ value: T; label: string }>; value: T; onChange: (v: T) => void; accessibilityLabel?: string }) {
  const { colors, elevation, motion, radii } = useTheme();
  const reduce = useReducedMotion();
  const [w, setW] = useState(0);
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const x = useSharedValue(0);
  const segW = w / options.length;
  useEffect(() => {
    if (!w) return;
    x.value = reduce ? index * segW : withSpring(index * segW, motion.spring.snappy);
  }, [index, segW, w, reduce, motion.spring.snappy, x]);
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
      style={[styles.track, { backgroundColor: colors.skeleton, borderRadius: radii.pill }]}
    >
      {w ? <Animated.View style={[styles.thumb, elevation(1), { width: segW - 6, borderRadius: radii.pill, backgroundColor: colors.surface }, thumb]} /> : null}
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            hitSlop={4}
            onPress={() => {
              if (on) return;
              hapticTap();
              onChange(o.value);
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={styles.seg}
          >
            <Text variant="label" maxFontSizeMultiplier={1.2} numberOfLines={1} style={{ color: on ? colors.text : colors.textSecondary, fontSize: 13 }}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: "row", height: 40, padding: 3 },
  thumb: { position: "absolute", top: 3, bottom: 3, left: 3 },
  seg: { flex: 1, alignItems: "center", justifyContent: "center" },
});
