import { useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { runOnJS, useAnimatedScrollHandler, useAnimatedStyle, useReducedMotion, useSharedValue, interpolate, Extrapolation, type SharedValue } from "react-native-reanimated";
import { hapticTap } from "../../services/haptics";
import { useTheme } from "../../theme/ThemeProvider";
import { wheelIndex } from "../../utils/pickers";
import { Text } from "../primitives";

export const WHEEL_ITEM = 44;
const VISIBLE = 5;

/**
 * One drum of the time picker (UI v3): rows curve away and fade above and below the centre (rotateX + scale +
 * opacity from the scroll position), it snaps to a row, and each row passing the centre ticks lightly. Screen readers
 * get an adjustable control (swipe up / down = next / previous).
 */
export function Wheel({ items, index, onChange, label, width = 72 }: { items: string[]; index: number; onChange: (i: number) => void; label: string; width?: number }) {
  const { colors } = useTheme();
  const reduce = useReducedMotion();
  const ref = useRef<Animated.ScrollView>(null);
  const y = useSharedValue(index * WHEEL_ITEM);
  const last = useSharedValue(index);
  const settled = useRef(index);

  // Follow outside changes (a quick-time chip) without fighting the finger.
  useEffect(() => {
    if (index === settled.current) return;
    settled.current = index;
    ref.current?.scrollTo({ y: index * WHEEL_ITEM, animated: !reduce });
  }, [index, reduce]);

  const tick = () => hapticTap();
  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      y.value = e.contentOffset.y;
      const i = Math.max(0, Math.min(items.length - 1, Math.round(e.contentOffset.y / WHEEL_ITEM)));
      if (i !== last.value) {
        last.value = i;
        runOnJS(tick)();
      }
    },
  });
  const settle = (offset: number) => {
    const i = wheelIndex(offset, WHEEL_ITEM, items.length);
    settled.current = i;
    if (i !== index) onChange(i);
  };

  return (
    <View
      style={{ width, height: WHEEL_ITEM * VISIBLE }}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ text: items[index] }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) => {
        const next = e.nativeEvent.actionName === "increment" ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1);
        if (next !== index) {
          settled.current = next;
          ref.current?.scrollTo({ y: next * WHEEL_ITEM, animated: false });
          onChange(next);
        }
      }}
    >
      <Animated.ScrollView
        ref={ref}
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        snapToInterval={WHEEL_ITEM}
        decelerationRate="fast"
        contentOffset={{ x: 0, y: index * WHEEL_ITEM }}
        onLayout={() => ref.current?.scrollTo({ y: settled.current * WHEEL_ITEM, animated: false })}
        onMomentumScrollEnd={(e) => settle(e.nativeEvent.contentOffset.y)}
        onScrollEndDrag={(e) => {
          // No fling: the drag's end is where it stops.
          if (Math.abs(e.nativeEvent.velocity?.y ?? 0) < 0.05) settle(e.nativeEvent.contentOffset.y);
        }}
        contentContainerStyle={{ paddingVertical: WHEEL_ITEM * 2 }}
        nestedScrollEnabled
      >
        {items.map((it, i) => (
          <WheelRow key={`${it}-${i}`} text={it} i={i} y={y} color={colors.text} flat={reduce} />
        ))}
      </Animated.ScrollView>
    </View>
  );
}

function WheelRow({ text, i, y, color, flat }: { text: string; i: number; y: SharedValue<number>; color: string; flat: boolean }) {
  const style = useAnimatedStyle(() => {
    const d = (y.value - i * WHEEL_ITEM) / WHEEL_ITEM; // rows from centre
    const a = Math.min(2.5, Math.abs(d));
    return {
      opacity: interpolate(a, [0, 1, 2.5], [1, 0.55, 0.15], Extrapolation.CLAMP),
      transform: flat ? [] : [{ perspective: 400 }, { rotateX: `${Math.max(-70, Math.min(70, d * 24))}deg` }, { scale: interpolate(a, [0, 2.5], [1, 0.82], Extrapolation.CLAMP) }],
    };
  });
  return (
    <Animated.View style={[styles.row, style]}>
      <Text variant="title2" tabular maxFontSizeMultiplier={1} style={{ color }}>
        {text}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { height: WHEEL_ITEM, alignItems: "center", justifyContent: "center" },
});
