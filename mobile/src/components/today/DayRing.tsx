import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedProps, useReducedMotion, useSharedValue, withTiming, Easing } from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";
import { useTheme } from "../../theme/ThemeProvider";
import { Text } from "../primitives";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * Today's progress (UI v3): a ring that fills as items are done (300 ms ease-out; reduce motion: no animation), with
 * "done/total" inside. All done turns it green. Decorative for screen readers: the header line says the same.
 */
export function DayRing({ done, total, size = 72 }: { done: number; total: number; size?: number }) {
  const { colors } = useTheme();
  const reduce = useReducedMotion();
  const stroke = 7;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const ratio = total ? Math.min(1, done / total) : 0;
  const p = useSharedValue(ratio);
  useEffect(() => {
    p.value = reduce ? ratio : withTiming(ratio, { duration: 300, easing: Easing.out(Easing.cubic) });
  }, [ratio, reduce, p]);
  const props = useAnimatedProps(() => ({ strokeDashoffset: c * (1 - p.value) }));
  const complete = total > 0 && done >= total;
  const tint = complete ? colors.success.fg : colors.accent;
  return (
    <View style={{ width: size, height: size }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.chartGrid} strokeWidth={stroke} fill="none" />
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={tint}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${c} ${c}`}
          animatedProps={props}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={[StyleSheet.absoluteFill, styles.center]}>
        <Text variant="headline" tabular maxFontSizeMultiplier={1.1} style={{ color: complete ? colors.success.fg : colors.text }}>
          {total ? `${done}/${total}` : "–"}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({ center: { alignItems: "center", justifyContent: "center" } });
